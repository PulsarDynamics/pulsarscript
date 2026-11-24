// Generates site/site-data.js from vm/hostapi.json and live PulsarScript compiler output.
// Run: bun run gen:site
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOST_FUNCTIONS, type HostFunction } from "../HostApi";
import { Lexer } from "../Lexer";
import { Parser } from "../Parser";
import { SemanticAnalyzer } from "../SemanticAnalyzer";
import { BytecodeCompiler } from "../BytecodeCompiler";
import { Opcode, withHeader, type BytecodeFile } from "../Bytecode";
import { linkModule } from "../Linker";
import { ImportStmt } from "../classes/ImportStmt";
import { ExportStmt } from "../classes/ExportStmt";
import { Interpreter, type EventBridge } from "../Interpreter";
import type { IOBridge } from "../interfaces/IO";
import { stringify } from "../Values";
import pkg from "../package.json";

interface ShowcaseSpec {
  id: string;
  label: string;
  title: string;
  summary: string;
  filePath?: string;
  multiFile?: boolean;
  code?: string;
  runCustom?: (interp: Interpreter, capturedPrints: string[], emittedEvents: unknown[]) => string[];
}

export interface SiteFunctionEntry {
  name: string;
  signature: string;
  provider: "core" | "host";
  capability: string | null;
  category: string;
  params: {
    name: string;
    type: string;
    optional: boolean;
    variadic: boolean;
  }[];
  returns: string;
  doc: string;
}

export interface SiteExampleEntry {
  id: string;
  label: string;
  title: string;
  summary: string;
  multiFile: boolean;
  source: string;
  disassembly: string;
  output: string;
  stats: {
    version: number;
    compiler: string;
    opcodes: number;
    constants: number;
    functions: number;
    sources: string[];
    sourceHashShort: string;
  };
}

const CAPABILITY_CATEGORIES: Record<string, string> = {
  "fs.read": "Filesystem Read",
  "fs.write": "Filesystem Write",
  kv: "Key-Value Store",
  events: "Host Events",
  window: "Window Messaging",
  ipc: "PulsarOS IPC",
};

const CORE_CATEGORIES: Record<string, string> = {
  typeOf: "Types & Coercion",
  string: "Types & Coercion",
  number: "Types & Coercion",
  concat: "Types & Coercion",
  len: "Types & Coercion",
  parseInt: "Types & Coercion",
  parseFloat: "Types & Coercion",
  toNumberOr: "Types & Coercion",
  abs: "Math",
  floor: "Math",
  ceil: "Math",
  round: "Math",
  sqrt: "Math",
  pow: "Math",
  min: "Math",
  max: "Math",
  clamp: "Math",
  isInteger: "Math",
  isFinite: "Math",
  sin: "Math",
  cos: "Math",
  tan: "Math",
  atan2: "Math",
  log: "Math",
  log10: "Math",
  exp: "Math",
  mathPi: "Math",
  mathE: "Math",
  toUpper: "Strings",
  toLower: "Strings",
  trim: "Strings",
  indexOf: "Strings",
  lastIndexOf: "Strings",
  split: "Strings",
  replace: "Strings",
  startsWith: "Strings",
  endsWith: "Strings",
  repeat: "Strings",
  padStart: "Strings",
  padEnd: "Strings",
  charCodeAt: "Strings",
  fromCharCode: "Strings",
  substr: "Strings",
  arrayLen: "Arrays",
  arrayPush: "Arrays",
  arrayPop: "Arrays",
  arraySlice: "Arrays",
  arrayConcat: "Arrays",
  arrayIndexOf: "Arrays",
  arrayJoin: "Arrays",
  arrayIncludes: "Arrays",
  arrayMap: "Arrays",
  arrayFilter: "Arrays",
  arrayReduce: "Arrays",
  arrayFind: "Arrays",
  arraySort: "Arrays",
  objKeys: "Objects",
  objValues: "Objects",
  objHas: "Objects",
  objGet: "Objects",
  objSet: "Objects",
  objDelete: "Objects",
  objEntries: "Objects",
  objMerge: "Objects",
  jsonParse: "JSON & Time",
  jsonStringify: "JSON & Time",
  clock: "JSON & Time",
  dateFormat: "JSON & Time",
  dateParse: "JSON & Time",
  random: "Random",
  randomInt: "Random",
  randomSeed: "Random",
  registerHandler: "Events & Runtime",
  on: "Events & Runtime",
  emit: "Events & Runtime",
  sleep: "Events & Runtime",
  yield: "Events & Runtime",
};

function categorize(fn: HostFunction): string {
  if (fn.provider === "host") {
    return CAPABILITY_CATEGORIES[fn.capability ?? ""] ?? "Host API";
  }
  const cat = CORE_CATEGORIES[fn.name];
  if (!cat) {
    throw new Error(`Uncategorized core function in scripts/gen-site-data.ts: ${fn.name}`);
  }
  return cat;
}

function formatSignature(fn: HostFunction): string {
  const params = fn.params
    .map((p) => (p.variadic ? `...${p.name}` : p.optional ? `${p.name}?` : p.name))
    .join(", ");
  return `${fn.name}(${params})`;
}

// Operand counts matching vm/hostapi.go opcodeInfo
const ONE_OPERAND_OPCODES = new Set<number>([
  Opcode.CONST,
  Opcode.DEFINE_GLOBAL,
  Opcode.GET_GLOBAL,
  Opcode.SET_GLOBAL,
  Opcode.GET_LOCAL,
  Opcode.SET_LOCAL,
  Opcode.JUMP,
  Opcode.JUMP_IF_FALSE,
  Opcode.ENTER_BLOCK,
  Opcode.EXIT_BLOCK,
  Opcode.TRY_PUSH,
  Opcode.NEW_ARRAY,
  Opcode.NEW_OBJECT,
  Opcode.INDEX_GET,
  Opcode.INDEX_SET,
  Opcode.FUNC,
  Opcode.CALL_VALUE,
  Opcode.CLOSURE,
  Opcode.GET_UPVALUE,
  Opcode.SET_UPVALUE,
  Opcode.CLOSE_UPVALUE,
]);

const TWO_OPERAND_OPCODES = new Set<number>([Opcode.CALL, Opcode.HOST_CALL]);

function previewConst(v: unknown): string {
  if (v === null) return "nil";
  if (typeof v === "string") {
    const clean = JSON.stringify(v);
    return clean.length > 28 ? `${clean.slice(0, 25)}..."` : clean;
  }
  return String(v);
}

function disassemble(bundle: BytecodeFile, maxLines = 42): string {
  const code = bundle.code;
  const lineMap = bundle.lineMap ?? [];
  const fnByAddr = new Map<number, string>();
  for (const fn of bundle.functions ?? []) {
    fnByAddr.set(fn.address, `${fn.name || "<anon>"} (arity=${fn.arity}, locals=${fn.locals})`);
  }

  const lines: string[] = [];
  for (let ip = 0; ip < code.length; ) {
    if (fnByAddr.has(ip)) {
      lines.push(`; fn ${fnByAddr.get(ip)} @ ${String(ip).padStart(4, "0")}`);
    }
    const op = code[ip];
    const name = Opcode[op] ?? `OP_${op}`;
    const lineNo = lineMap[ip] ? `  ; line ${lineMap[ip]}` : "";
    const addr = String(ip).padStart(4, "0");

    if (TWO_OPERAND_OPCODES.has(op)) {
      const op1 = code[ip + 1];
      const op2 = code[ip + 2];
      let note = "";
      if (op === Opcode.HOST_CALL) {
        note = ` (${previewConst(bundle.constants[op1])}, argc=${op2})`;
      } else if (op === Opcode.CALL) {
        note = ` (addr=${op1}, argc=${op2})`;
      }
      lines.push(`  ${addr}: ${name.padEnd(15)} ${op1} ${op2}${note}${lineNo}`);
      ip += 3;
    } else if (ONE_OPERAND_OPCODES.has(op)) {
      const op1 = code[ip + 1];
      let note = "";
      if (
        op === Opcode.CONST ||
        op === Opcode.DEFINE_GLOBAL ||
        op === Opcode.GET_GLOBAL ||
        op === Opcode.SET_GLOBAL
      ) {
        note = ` (${previewConst(bundle.constants[op1])})`;
      } else if (op === Opcode.CLOSURE || op === Opcode.FUNC) {
        const target = fnByAddr.get(op1);
        if (target) note = ` (${target})`;
      }
      lines.push(`  ${addr}: ${name.padEnd(15)} ${op1}${note}${lineNo}`);
      ip += 2;
    } else {
      lines.push(`  ${addr}: ${name}${lineNo}`);
      ip += 1;
    }

    if (lines.length >= maxLines && ip < code.length) {
      lines.push(`  ... (${code.length - ip} more bytecode words in module)`);
      break;
    }
  }
  return lines.join("\n");
}

function captureInterpreterOutput(fn: () => void): string[] {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return captured;
}

const SHOWCASE_SPECS: ShowcaseSpec[] = [
  {
    id: "closures",
    label: "Closures",
    title: "Closures & Upvalues",
    summary:
      "First-class functions capture enclosing locals as Lua-style shared upvalues compiled to OP_CLOSURE, OP_GET_UPVALUE, OP_SET_UPVALUE, and OP_CLOSE_UPVALUE.",
    code: `function makeCounter(start, step) {
  var value = start;
  return function() {
    var current = value;
    value += step;
    return current;
  };
}

var nextId = makeCounter(100, 10);
var ids = arrayMap([0, 0, 0], function(_) {
  return nextId();
});

print("ids: " + jsonStringify(ids));
print("type: " + typeOf(nextId) + " -> " + string(nextId));`,
  },
  {
    id: "cow",
    label: "CoW Values",
    title: "Copy-on-Write Value Semantics (D15)",
    summary:
      "Every assignment copies by value semantics, while Copy-on-Write structural sharing makes 20,000 array appends and 10,000 object key writes run in milliseconds.",
    code: `var base = { tags: ["rpc", "sandbox"], count: 1 };
var snapshot = base; // Independent snapshot under D15

// Nested index assignment compiles cleanly in v1.2
base.tags[len(base.tags)] = "cow";
base.count = 42;
base.removed = true;
base = objDelete(base, "removed");

print("snapshot: " + jsonStringify(snapshot));
print("updated:  " + jsonStringify(base));`,
  },
  {
    id: "strings",
    label: "Templates & Sort",
    title: "Escapes, Templates & String Ordering",
    summary:
      "Full Unicode escapes (\\u{...}), nested template literals, and lexicographic code-point ordering (<, <=, >, >=) work out of the box.",
    code: `var files = ["zeta.puls", "alpha.puls", "beta.puls"];
var ordered = arraySort(files);

var lines = arrayMap(ordered, function(name) {
  var badge = name < "gamma" ? "core" : "tail";
  return \`\u{2022} \${padEnd(name, 11)} [\${badge}]\`;
});

print(arrayJoin(lines, "\\n"));
print("alpha < beta? " + string("alpha" < "beta"));`,
  },
  {
    id: "syntax",
    label: "JSON & Dates",
    title: "JSON, Dates & Pragmatic Syntax",
    summary:
      "Block comments /* ... */, ternary ?:, hex 0x..., scientific 1e3, canonical sorted-key JSON, and UTC date helpers share strict Go VM parity.",
    code: `/* Parse, annotate, and format deterministically */
var hexPort = 0x1055;
var budgetMs = 1.5e3;
var payload = jsonParse("{\\"z\\":true,\\"a\\":42}");

var mode = budgetMs <= 1500 ? "rpc" : "service";
var ts = dateParse("2026-11-23T20:00:00Z");
var out = objMerge(payload, {
  mode: mode,
  port: hexPort,
  day: dateFormat(ts, "YYYY-MM-DD")
});

print(jsonStringify(out));`,
  },
  {
    id: "events",
    label: "Capabilities",
    title: "Capability-Gated Host Calls (fs + kv + events)",
    summary:
      "Every host call is typed in hostapi.json and checked at runtime against granted manifest capabilities. Try toggling fs.read or kv off above!",
    code: `// Read sandboxed files & state via capability gates
var files = fsList("/docs");
var names = arrayMap(files, function(e) { return e.name; });
var sorted = arraySort(names);

kvSet("lastDir", "/docs");
emitEvent({ action: "listed", count: len(sorted) });

print("docs: " + jsonStringify(sorted));
print("kv.theme: " + string(kvGet("theme")));`,
    runCustom: (interp, printed, emittedEvents) => [
      ...printed,
      ...emittedEvents.map((e) => `emitted: ${JSON.stringify(e)}`),
    ],
  },
  {
    id: "cage",
    label: "Memory Cage",
    title: "Uncatchable Step & Memory Budgets",
    summary:
      "Runaway loops and allocation bombs hit MemoryLimitError or BudgetError cleanly—and try/catch can never intercept or outlive a budget violation.",
    code: `// Even try/catch cannot escape a hard budget cap
try {
  var blob = "pulsar-";
  for (var i = 0; i < 40; i += 1) {
    blob = blob + blob;
  }
  print("unexpected length: " + string(len(blob)));
} catch (err) {
  print("caught in script: " + err.message);
}`,
  },
  {
    id: "modules",
    label: "Modules & RPC",
    title: "Linked Modules & File Manager RPC",
    summary:
      "import/export modules link at build time into a single portable Bytecode v3 bundle with unified source maps across files (examples/file-manager-reference.puls).",
    filePath: "examples/file-manager-reference.puls",
    multiFile: true,
    runCustom: (interp, _prints, _emitted) => {
      const sorted = interp.callHandler("listSorted", ["/docs", "name", true]);
      const plan = interp.callHandler("planRename", ["/docs", ".txt", ".md", "v2_"]);
      const page1 = interp.callHandler("applyRenamePage", [plan, 0, 2]);
      return [
        `handlers: listSorted, planRename, applyRenamePage`,
        `listSorted(3 entries) -> ${stringify(sorted)}`,
        `applyRenamePage(cursor=0, size=2) -> ${stringify(page1)}`,
      ];
    },
  },
];

function createMockIOBridge(): IOBridge {
  const sampleEntries = [
    { name: "notes.md", isDir: false, size: 1420 },
    { name: "spec.md", isDir: false, size: 512 },
    { name: "todo.txt", isDir: false, size: 256 },
    { name: "assets", isDir: true, size: 0 },
  ];
  const kv = new Map<string, unknown>([["theme", "pulsar-dark"]]);
  return {
    readFile: () => null,
    writeFile: () => true,
    listDir: () => sampleEntries,
    rename: () => true,
    kvGet: (k) => (kv.has(k) ? kv.get(k) : null),
    kvSet: (k, v) => {
      kv.set(k, v);
      return true;
    },
  };
}

function buildExamples(): SiteExampleEntry[] {
  const results: SiteExampleEntry[] = [];

  for (const spec of SHOWCASE_SPECS) {
    let sourceText = spec.code ?? "";
    let stmts;
    let sources: string[] = ["main.puls"];

    if (spec.filePath) {
      const abs = resolve(spec.filePath);
      sourceText = readFileSync(abs, "utf8");
      const linked = linkModule(abs, { entrySource: sourceText });
      stmts = linked.statements;
      sources = linked.sources;
    } else {
      const tokens = new Lexer(sourceText).scanTokens();
      stmts = new Parser(tokens).parse();
      if (stmts.some((s) => s instanceof ImportStmt || s instanceof ExportStmt)) {
        throw new Error(`Unexpected module statement in inline example ${spec.id}`);
      }
    }

    const analyzer = new SemanticAnalyzer();
    analyzer.analyze(stmts);
    const chunk = BytecodeCompiler.compile(stmts, sources);
    const bundle = withHeader(chunk, sourceText, pkg.version);

    const emittedEvents: unknown[] = [];
    const eventBridge: EventBridge = {
      emit: (payload) => {
        emittedEvents.push(payload);
        return null;
      },
      poll: () => null,
    };

    const interp = new Interpreter({
      io: createMockIOBridge(),
      events: eventBridge,
      limits:
        spec.id === "cage"
          ? { maxSteps: 50_000, timeoutMs: 500, maxStringBytes: 256 * 1024, maxMemoryBytes: 2 * 1024 * 1024 }
          : undefined,
    });

    let cageError = "";
    const printed = captureInterpreterOutput(() => {
      try {
        interp.interpret(stmts, sources);
      } catch (err) {
        if (spec.id === "cage" && err instanceof Error) {
          cageError = `[uncatchable ${err.name}] ${err.message}`;
        } else {
          throw err;
        }
      }
    });

    const outputLines = spec.runCustom ? spec.runCustom(interp, printed, emittedEvents) : printed;
    if (cageError) outputLines.push(cageError);

    results.push({
      id: spec.id,
      label: spec.label,
      title: spec.title,
      summary: spec.summary,
      multiFile: Boolean(spec.multiFile),
      source: sourceText.trimEnd(),
      disassembly: disassemble(bundle),
      output: outputLines.join("\n"),
      stats: {
        version: bundle.version,
        compiler: bundle.compiler,
        opcodes: bundle.code.length,
        constants: bundle.constants.length,
        functions: (bundle.functions ?? []).length,
        sources,
        sourceHashShort: bundle.sourceHash.replace("sha256:", "").slice(0, 12),
      },
    });
  }

  return results;
}

function buildFunctions(): SiteFunctionEntry[] {
  return HOST_FUNCTIONS.map((fn) => ({
    name: fn.name,
    signature: formatSignature(fn),
    provider: fn.provider,
    capability: fn.capability ?? null,
    category: categorize(fn),
    params: fn.params.map((p) => ({
      name: p.name,
      type: p.type,
      optional: Boolean(p.optional),
      variadic: Boolean(p.variadic),
    })),
    returns: fn.returns,
    doc: fn.doc,
  }));
}

function countConformanceCases(dir: string): number {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name.startsWith(".")) continue;
    if (statSync(full).isDirectory()) {
      count += countConformanceCases(full);
    } else if (name.endsWith(".expected")) {
      count++;
    }
  }
  return count;
}

interface DocsConformanceExample {
  id: string;
  category: string;
  title: string;
  path: string;
  code: string;
  expected: string;
  runnable: boolean;
}

const DOCS_EXAMPLE_CATEGORIES = [
  "basics",
  "closures",
  "functions",
  "arrays",
  "objects",
  "strings",
  "stdlib",
  "templates",
  "control",
  "loops",
  "events",
  "operators",
];

function buildConformanceExamples(): DocsConformanceExample[] {
  const root = resolve("tests/conformance");
  const picked: DocsConformanceExample[] = [];

  for (const category of DOCS_EXAMPLE_CATEGORIES) {
    const dir = join(root, category);
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    let takenInCategory = 0;
    for (const file of entries) {
      if (takenInCategory >= 3) break;
      if (!file.endsWith(".puls")) continue;
      const stem = file.slice(0, -5);
      const expectedPath = join(dir, `${stem}.expected`);
      let expectedRaw = "";
      try {
        expectedRaw = readFileSync(expectedPath, "utf8").trimEnd();
      } catch {
        continue;
      }
      if (
        !expectedRaw ||
        expectedRaw.startsWith("!") ||
        expectedRaw === "runtime" ||
        expectedRaw === "semantic" ||
        expectedRaw === "compile" ||
        expectedRaw === "parse"
      ) {
        continue;
      }
      const code = readFileSync(join(dir, file), "utf8").trimEnd();
      const lines = code.split("\n");
      if (lines.length > 36) continue;
      const hasModule = /\b(import|export)\b/.test(code);
      if (hasModule) continue;

      picked.push({
        id: `${category}/${stem}`,
        category,
        title: stem.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        path: `tests/conformance/${category}/${file}`,
        code,
        expected: expectedRaw,
        runnable: true,
      });
      takenInCategory++;
    }
  }

  return picked;
}

const functions = buildFunctions();
const examples = buildExamples();
const conformanceCount = countConformanceCases(resolve("tests/conformance"));
const conformanceExamples = buildConformanceExamples();

const meta = {
  version: pkg.version,
  specVersion: "1.0",
  bytecodeVersion: 3,
  opcodeCount: 52,
  totalFunctions: functions.length,
  coreFunctions: functions.filter((f) => f.provider === "core").length,
  hostFunctions: functions.filter((f) => f.provider === "host").length,
  capabilities: [...new Set(functions.map((f) => f.capability).filter(Boolean))],
  conformanceCount,
};

const payload = {
  meta,
  functions,
  examples,
};

const outPath = new URL("../site/site-data.js", import.meta.url).pathname;
const banner = "// Generated by scripts/gen-site-data.ts from vm/hostapi.json and PulsarScript compiler.\n";
await Bun.write(outPath, `${banner}globalThis.PULSARSCRIPT_SITE_DATA = ${JSON.stringify(payload, null, 2)};\n`);

const specMarkdown = readFileSync(resolve("SPEC.md"), "utf8");
const guideMarkdown = readFileSync(resolve("docs/first-app-guide.md"), "utf8");
const manifestSchema = JSON.parse(readFileSync(resolve("contracts/app_manifest.schema.json"), "utf8"));
const exampleManifest = JSON.parse(readFileSync(resolve("contracts/fixtures/manifest/valid-full.json"), "utf8"));

const docsPayload = {
  meta,
  functions,
  examples,
  conformanceExamples,
  specMarkdown,
  guideMarkdown,
  manifestSchema,
  exampleManifest,
  sdkReference: {
    protocolVersion: "1.0.0",
    bridgeGlobals: [
      {
        name: "Pulsar.script.call(handler, args)",
        returns: "Promise<any>",
        description: "Invokes a named RPC handler registered via registerHandler(name, fn) in the app script VM.",
      },
      {
        name: "Pulsar.events.on(eventName, callback)",
        returns: "() => void",
        description: "Subscribes UI components to events emitted from script handlers via emit(name, payload).",
      },
      {
        name: "Pulsar.info",
        returns: "{ appId, version, scopes }",
        description: "Exposes verified manifest metadata and granted permission scopes for the running bundle.",
      },
      {
        name: "Pulsar.theme",
        returns: "{ name, scheme, vars }",
        description: "Provides the active host theme snapshot (light/dark scheme and CSS custom properties).",
      },
      {
        name: "Pulsar.os.openUrl(url)",
        returns: "Promise<boolean>",
        description: "Prompts the desktop host to open a vetted http:/https: URL after explicit user confirmation.",
      },
    ],
    cliCommands: [
      {
        cmd: "bun run fmt <files...>",
        description: "Canonical PulsarScript formatter (DX-01). Use --check in CI or --stdin in editor integrations.",
      },
      {
        cmd: "bun run lint <files...>",
        description: "Static linter checking unused bindings, shadowing, host signatures, and AppManifest capability scopes (DX-02).",
      },
      {
        cmd: "bun run lsp",
        description: "Starts the stdio PulsarScript Language Server (diagnostics, completion, hover, signatures, go-to-definition) (DX-03).",
      },
      {
        cmd: "bun run compile -- -g -s main.puls main.json",
        description: "Compiles .puls (linking relative ./ modules) to Bytecode v3 JSON with source maps and local names.",
      },
      {
        cmd: "cd vm && go run ./cmd/vmrun -debug ../main.json",
        description: "Runs Bytecode v3 inside the Go VM interactive breakpoint & step debugger (DX-05).",
      },
    ],
  },
};

const docsOutPath = new URL("../site/docs-data.js", import.meta.url).pathname;
const docsBanner = "// Generated by scripts/gen-site-data.ts from SPEC.md, docs/first-app-guide.md, vm/hostapi.json, contracts, and tests/conformance.\n";
await Bun.write(
  docsOutPath,
  `${docsBanner}globalThis.PULSARSCRIPT_DOCS_DATA = ${JSON.stringify(docsPayload, null, 2)};\n`,
);

const runtimeEntry = new URL("./browser-runtime-entry.ts", import.meta.url).pathname;
const runtimeOutDir = new URL("../site", import.meta.url).pathname;
const buildRes = await Bun.build({
  entrypoints: [runtimeEntry],
  outdir: runtimeOutDir,
  naming: "pulsar-runtime.[ext]",
  target: "browser",
  format: "iife",
  minify: true,
  plugins: [
    {
      name: "browser-node-shims",
      setup(build) {
        build.onResolve({ filter: /^node:(crypto|fs|path)$/ }, (args) => ({
          path: args.path,
          namespace: "browser-node-shim",
        }));
        build.onLoad({ filter: /.*/, namespace: "browser-node-shim" }, (args) => {
          if (args.path === "node:crypto") {
            return {
              contents:
                'export function createHash() { return { update() { return this; }, digest() { return "browser-live"; } }; }',
              loader: "js",
            };
          }
          if (args.path === "node:fs") {
            return {
              contents:
                'export function existsSync() { return false; } export function readFileSync() { throw new Error("node:fs is not available in browser"); }',
              loader: "js",
            };
          }
          return {
            contents:
              'export function dirname() { return "."; } export function join(...p) { return p.join("/"); } export function resolve(...p) { return p.join("/"); }',
            loader: "js",
          };
        });
      },
    },
  ],
});

if (!buildRes.success) {
  for (const log of buildRes.logs) console.error(log);
  throw new Error("Failed to build site/pulsar-runtime.js");
}

const runtimeSizeKb = ((Bun.file(`${runtimeOutDir}/pulsar-runtime.js`).size ?? 0) / 1024).toFixed(1);
console.log(
  `Generated site/site-data.js (${payload.meta.totalFunctions} functions: ${payload.meta.coreFunctions} core, ${payload.meta.hostFunctions} host; ${examples.length} compiled examples) and site/pulsar-runtime.js (${runtimeSizeKb} KB).`,
);

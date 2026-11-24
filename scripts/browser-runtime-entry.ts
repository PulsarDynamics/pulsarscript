// Browser-safe PulsarScript compiler + sandboxed runtime entry bundled into site/pulsar-runtime.js.
import { Lexer } from "../Lexer";
import { Parser, ParseError } from "../Parser";
import { SemanticAnalyzer, SemanticError } from "../SemanticAnalyzer";
import { BytecodeCompiler } from "../BytecodeCompiler";
import { Opcode, withHeader, type Chunk } from "../Bytecode";
import {
  BudgetError,
  Interpreter,
  MemoryLimitError,
  RuntimeError,
  type EventBridge,
} from "../Interpreter";
import { ErrorReporter } from "../ErrorReporter";
import type { FileEntry, IOBridge } from "../interfaces/IO";
import { ImportStmt } from "../classes/ImportStmt";
import { ExportStmt } from "../classes/ExportStmt";
import { stringify } from "../Values";
import { formatPulsarScript } from "../tools/formatter";
import { lintPulsarScript, type LintDiagnostic } from "../tools/linter";
import pkg from "../package.json";

export interface SandboxCapabilities {
  "fs.read"?: boolean;
  "fs.write"?: boolean;
  kv?: boolean;
  events?: boolean;
}

export interface RunOptions {
  capabilities?: SandboxCapabilities;
  maxSteps?: number;
  timeoutMs?: number;
  maxStringBytes?: number;
  maxCollectionLen?: number;
  maxMemoryBytes?: number;
}

export interface RunResult {
  ok: boolean;
  stage: "ok" | "parse" | "semantic" | "capability" | "budget" | "memory" | "runtime";
  output: string;
  error: string | null;
  disassembly: string;
  events: string[];
  deniedCalls: string[];
  stats: {
    steps: number;
    maxSteps: number;
    memBytes: number;
    maxMemoryBytes: number;
    durationMs: number;
    opcodes: number;
    constants: number;
    functions: number;
  };
}

class CapabilityDeniedError extends Error {
  readonly capability: string;
  readonly fnName: string;

  constructor(capability: string, fnName: string) {
    super(`Permission denied: '${fnName}' requires capability '${capability}' (disabled in host sandbox).`);
    this.name = "CapabilityDeniedError";
    this.capability = capability;
    this.fnName = fnName;
  }
}

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
    return clean.length > 26 ? `${clean.slice(0, 23)}..."` : clean;
  }
  return String(v);
}

function disassembleChunk(chunk: Chunk, maxLines = 48): string {
  const code = chunk.code;
  const lineMap = chunk.lineMap ?? [];
  const fnByAddr = new Map<number, string>();
  for (const fn of chunk.functions ?? []) {
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
        note = ` (${previewConst(chunk.constants[op1])}, argc=${op2})`;
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
        note = ` (${previewConst(chunk.constants[op1])})`;
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

function createSandboxHost(caps: SandboxCapabilities) {
  const files = new Map<string, string>([
    ["/docs/notes.md", "# PulsarOS Notes\nSandboxed scripts stay inside their budget."],
    ["/docs/spec.md", "PulsarScript v1.2 — SPEC v1.0 · Bytecode v3"],
    ["/docs/todo.txt", "1. Verify CoW\n2. Gate host calls"],
  ]);
  const kvStore = new Map<string, unknown>([
    ["theme", "pulsar-dark"],
    ["lastDir", "/docs"],
  ]);
  const emitted: string[] = [];
  const deniedCalls: string[] = [];

  function requireCap(cap: keyof SandboxCapabilities, fnName: string): void {
    if (caps[cap] === false) {
      deniedCalls.push(`${fnName} -> requires ${cap}`);
      throw new CapabilityDeniedError(cap, fnName);
    }
  }

  function entriesFor(dirPath: string): FileEntry[] {
    const clean = dirPath.endsWith("/") && dirPath.length > 1 ? dirPath.slice(0, -1) : dirPath;
    if (clean === "/" || clean === "") {
      return [
        { name: "assets", isDir: true, size: 0 },
        { name: "docs", isDir: true, size: 0 },
      ];
    }
    const prefix = `${clean}/`;
    const list: FileEntry[] = [];
    for (const [path, content] of files.entries()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes("/")) {
        list.push({ name: rest, isDir: false, size: content.length });
      }
    }
    if (clean === "/docs") {
      list.push({ name: "archive", isDir: true, size: 0 });
    }
    return list;
  }

  const io: IOBridge = {
    readFile(path) {
      requireCap("fs.read", "fsRead");
      return files.get(path) ?? null;
    },
    writeFile(path, data) {
      requireCap("fs.write", "fsWrite");
      files.set(path, String(data));
      return true;
    },
    listDir(path) {
      requireCap("fs.read", "fsList");
      return entriesFor(path);
    },
    stat(path) {
      requireCap("fs.read", "fsStat");
      const content = files.get(path);
      if (content !== undefined) {
        const name = path.split("/").pop() || path;
        return { name, dir: false, size: content.length, modified: 1732406400000 };
      }
      if (path === "/docs" || path === "/assets") {
        return { name: path.slice(1), dir: true, size: 0, modified: 1732406400000 };
      }
      return null;
    },
    exists(path) {
      requireCap("fs.read", "fsExists");
      return files.has(path) || path === "/docs" || path === "/assets";
    },
    deleteFile(path) {
      requireCap("fs.write", "fsDelete");
      return files.delete(path);
    },
    mkdir(_path) {
      requireCap("fs.write", "fsMkdir");
      return true;
    },
    rename(from, to) {
      requireCap("fs.write", "fsRename");
      const val = files.get(from);
      if (val === undefined) return false;
      files.delete(from);
      files.set(to, val);
      return true;
    },
    copy(from, to) {
      requireCap("fs.write", "fsCopy");
      const val = files.get(from);
      if (val === undefined) return false;
      files.set(to, val);
      return true;
    },
    quota() {
      requireCap("fs.read", "fsQuota");
      let used = 0;
      for (const content of files.values()) used += content.length;
      return { used, max: 1024 * 1024 };
    },
    kvGet(key) {
      requireCap("kv", "kvGet");
      return kvStore.has(key) ? kvStore.get(key) : null;
    },
    kvSet(key, value) {
      requireCap("kv", "kvSet");
      kvStore.set(key, value);
      return true;
    },
    kvDelete(key) {
      requireCap("kv", "kvDelete");
      return kvStore.delete(key);
    },
  };

  const events: EventBridge = {
    emit(payload) {
      requireCap("events", "emitEvent");
      emitted.push(typeof payload === "string" ? payload : JSON.stringify(payload));
      return null;
    },
    poll() {
      requireCap("events", "pollEvent");
      return null;
    },
    notifyWindow(payload) {
      emitted.push(`window: ${JSON.stringify(payload)}`);
      return null;
    },
  };

  return { io, events, emitted, deniedCalls };
}

export function compileAndRun(source: string, opts: RunOptions = {}): RunResult {
  const caps: SandboxCapabilities = {
    "fs.read": opts.capabilities?.["fs.read"] ?? true,
    "fs.write": opts.capabilities?.["fs.write"] ?? true,
    kv: opts.capabilities?.kv ?? true,
    events: opts.capabilities?.events ?? true,
  };
  const maxSteps = opts.maxSteps ?? 50_000;
  const timeoutMs = opts.timeoutMs ?? 500;
  const maxStringBytes = opts.maxStringBytes ?? 256 * 1024;
  const maxCollectionLen = opts.maxCollectionLen ?? 20_000;
  const maxMemoryBytes = opts.maxMemoryBytes ?? 2 * 1024 * 1024;

  const t0 = performance.now();
  const reporter = new ErrorReporter(source);
  const host = createSandboxHost(caps);
  const printed: string[] = [];
  let disassembly = "";
  let opcodeCount = 0;
  let constantCount = 0;
  let functionCount = 0;

  let interpRef: { steps?: number; memBytes?: number } = {};
  const origLog = console.log;

  try {
    const tokens = new Lexer(source).scanTokens();
    const stmts = new Parser(tokens).parse();

    if (stmts.some((s) => s instanceof ImportStmt || s instanceof ExportStmt)) {
      return {
        ok: false,
        stage: "semantic",
        output: "",
        error:
          "Browser sandbox compiles single-file snippets. Multi-file import/export linking runs via `bun run compile.ts` (shown in the pre-linked Modules & RPC preset).",
        disassembly: "",
        events: [],
        deniedCalls: [],
        stats: {
          steps: 0,
          maxSteps,
          memBytes: 0,
          maxMemoryBytes,
          durationMs: Math.round((performance.now() - t0) * 10) / 10,
          opcodes: 0,
          constants: 0,
          functions: 0,
        },
      };
    }

    const analyzer = new SemanticAnalyzer();
    analyzer.analyze(stmts);
    const chunk = BytecodeCompiler.compile(stmts, ["sandbox.puls"]);
    disassembly = disassembleChunk(chunk);
    opcodeCount = chunk.code.length;
    constantCount = chunk.constants.length;
    functionCount = (chunk.functions ?? []).length;

    const interp = new Interpreter({
      io: host.io,
      events: host.events,
      limits: {
        maxSteps,
        timeoutMs,
        maxStringBytes,
        maxCollectionLen,
        maxMemoryBytes,
      },
    });
    interpRef = interp as unknown as { steps?: number; memBytes?: number };

    console.log = (...args: unknown[]) => {
      printed.push(args.map((a) => String(a)).join(" "));
    };

    try {
      interp.interpret(stmts, ["sandbox.puls"]);
    } finally {
      console.log = origLog;
    }

    for (const h of interp.handlerNames()) {
      printed.push(`[registeredHandler] ${h}`);
    }
    for (const evName of interp.eventListenerNames()) {
      printed.push(`[on("${evName}")] listener registered`);
    }

    const durationMs = Math.round((performance.now() - t0) * 10) / 10;
    return {
      ok: true,
      stage: "ok",
      output:
        printed.length > 0
          ? printed.join("\n")
          : "(Program completed cleanly with no printed output.)",
      error: null,
      disassembly,
      events: [...host.emitted],
      deniedCalls: [...host.deniedCalls],
      stats: {
        steps: interpRef.steps ?? 0,
        maxSteps,
        memBytes: interpRef.memBytes ?? 0,
        maxMemoryBytes,
        durationMs,
        opcodes: opcodeCount,
        constants: constantCount,
        functions: functionCount,
      },
    };
  } catch (err: unknown) {
    console.log = origLog;
    const durationMs = Math.round((performance.now() - t0) * 10) / 10;

    let stage: RunResult["stage"] = "runtime";
    let msg = err instanceof Error ? err.message : String(err);

    if (err instanceof ParseError) {
      stage = "parse";
      msg = reporter.formatError(err.token, err.message, "Parse").trim();
    } else if (err instanceof SemanticError) {
      stage = "semantic";
      msg = reporter.formatError(err.token, err.message, "Semantic").trim();
    } else if (err instanceof MemoryLimitError) {
      stage = "memory";
      msg = reporter.formatError(err.token, err.message, "Runtime").trim();
    } else if (err instanceof BudgetError) {
      stage = "budget";
    } else if (err instanceof CapabilityDeniedError || msg.includes("requires capability")) {
      stage = "capability";
    } else if (err instanceof RuntimeError) {
      stage = "runtime";
      msg = reporter.formatError(err.token, err.message, "Runtime").trim();
    }

    if (err instanceof CapabilityDeniedError && host.deniedCalls.length === 0) {
      host.deniedCalls.push(`${err.fnName} -> requires ${err.capability}`);
    }

    return {
      ok: false,
      stage,
      output: printed.join("\n"),
      error: msg,
      disassembly,
      events: [...host.emitted],
      deniedCalls: [...host.deniedCalls],
      stats: {
        steps: interpRef.steps ?? 0,
        maxSteps,
        memBytes: interpRef.memBytes ?? 0,
        maxMemoryBytes,
        durationMs,
        opcodes: opcodeCount,
        constants: constantCount,
        functions: functionCount,
      },
    };
  }
}

export interface WasmCompileResult {
  ok: boolean;
  stage: "ok" | "parse" | "semantic";
  bytecodeJson: string | null;
  disassembly: string;
  error: string | null;
  errorLine: number | null;
  stats: {
    opcodes: number;
    constants: number;
    functions: number;
  };
}

export interface FormatSourceResult {
  ok: boolean;
  formatted: string;
  changed: boolean;
  error: string | null;
}

export interface LintSourceResult {
  ok: boolean;
  diagnostics: LintDiagnostic[];
  errors: number;
  warnings: number;
}

export function compileForWasm(source: string): WasmCompileResult {
  const reporter = new ErrorReporter(source);
  try {
    const tokens = new Lexer(source).scanTokens();
    const stmts = new Parser(tokens).parse();

    if (stmts.some((s) => s instanceof ImportStmt || s instanceof ExportStmt)) {
      return {
        ok: false,
        stage: "semantic",
        bytecodeJson: null,
        disassembly: "",
        error:
          "Browser sandbox compiles single-file snippets. Multi-file import/export linking runs via `bun run compile.ts` (shown in the pre-linked Modules & RPC preset).",
        errorLine: null,
        stats: { opcodes: 0, constants: 0, functions: 0 },
      };
    }

    const analyzer = new SemanticAnalyzer();
    analyzer.analyze(stmts);

    const chunk = BytecodeCompiler.compile(stmts, ["sandbox.puls"], { debug: true });
    const filePayload = withHeader(chunk, source, pkg.version);
    return {
      ok: true,
      stage: "ok",
      bytecodeJson: JSON.stringify(filePayload),
      disassembly: disassembleChunk(chunk),
      error: null,
      errorLine: null,
      stats: {
        opcodes: chunk.code.length,
        constants: chunk.constants.length,
        functions: (chunk.functions ?? []).length,
      },
    };
  } catch (err: unknown) {
    let stage: WasmCompileResult["stage"] = "semantic";
    let msg = err instanceof Error ? err.message : String(err);
    let errorLine: number | null = null;
    if (err instanceof ParseError) {
      stage = "parse";
      errorLine = err.token?.line ?? null;
      msg = reporter.formatError(err.token, err.message, "Parse").trim();
    } else if (err instanceof SemanticError) {
      stage = "semantic";
      errorLine = err.token?.line ?? null;
      msg = reporter.formatError(err.token, err.message, "Semantic").trim();
    }
    return {
      ok: false,
      stage,
      bytecodeJson: null,
      disassembly: "",
      error: msg,
      errorLine,
      stats: { opcodes: 0, constants: 0, functions: 0 },
    };
  }
}

export function formatSource(source: string): FormatSourceResult {
  try {
    const formatted = formatPulsarScript(source);
    return {
      ok: true,
      formatted,
      changed: formatted !== source,
      error: null,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      formatted: source,
      changed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function lintSource(
  source: string,
  capabilities?: Record<string, boolean>,
): LintSourceResult {
  const scopes: string[] = [];
  if (capabilities) {
    for (const [scope, enabled] of Object.entries(capabilities)) {
      if (enabled) scopes.push(scope);
    }
  } else {
    scopes.push("fs.read", "fs.write", "kv", "events");
  }
  const diagnostics = lintPulsarScript(source, {
    filePath: "sandbox.puls",
    manifest: {
      permissions: {
        scopes,
      },
    },
  });
  return {
    ok: diagnostics.every((d) => d.severity !== "error"),
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
  };
}

void stringify;

(
  globalThis as unknown as {
    PulsarRuntime: {
      compileAndRun: typeof compileAndRun;
      compileForWasm: typeof compileForWasm;
      formatSource: typeof formatSource;
      lintSource: typeof lintSource;
    };
  }
).PulsarRuntime = {
  compileAndRun,
  compileForWasm,
  formatSource,
  lintSource,
};

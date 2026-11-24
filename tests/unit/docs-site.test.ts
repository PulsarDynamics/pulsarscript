import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withHeader } from "../../Bytecode";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { Interpreter } from "../../Interpreter";
import { linkModule } from "../../Linker";
import { SemanticAnalyzer } from "../../SemanticAnalyzer";
import { toHost } from "../../Values";
import type { FileEntry, IOBridge } from "../../interfaces/IO";
import pkg from "../../package.json";
import { formatPulsarScript } from "../../tools/formatter";
import { lintPulsarScript } from "../../tools/linter";
import { validateManifest } from "../../tools/manifest-validator";
import { loadPulsarWasmVM } from "../../wasm/pulsar-wasm";

function extractMarkdownCodeBlocks(markdown: string): { lang: string; code: string }[] {
  const blocks: { lang: string; code: string }[] = [];
  const re = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push({ lang: m[1].toLowerCase(), code: m[2].trimEnd() });
  }
  return blocks;
}

describe("Generated docs site and First-App Guide (DX-06)", () => {
  test("first-app-guide.md builds, lints, compiles, and runs largestFiles on TS Interpreter and Go WASM VM", async () => {
    const guide = readFileSync(resolve("docs/first-app-guide.md"), "utf8");

    expect(guide).not.toContain('trim(ch) == ""');
    expect(guide).toContain("\\n");

    const blocks = extractMarkdownCodeBlocks(guide);
    const jsonBlock = blocks.find((b) => b.lang === "json" && b.code.includes("com.example.disk-peek"));
    const formatBlock = blocks.find((b) => b.lang === "puls" && b.code.includes("export function formatSummary"));
    const mainBlock = blocks.find((b) => b.lang === "puls" && b.code.includes('registerHandler("largestFiles"'));

    expect(jsonBlock).toBeDefined();
    expect(formatBlock).toBeDefined();
    expect(mainBlock).toBeDefined();

    const manifestObj = JSON.parse(jsonBlock!.code);
    const validation = validateManifest(manifestObj);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    const tmpRoot = mkdtempSync(join(tmpdir(), "pulsar-guide-app-"));
    try {
      const scriptsDir = join(tmpRoot, "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      const manifestPath = join(tmpRoot, "AppManifest.json");
      const formatPath = join(scriptsDir, "format.puls");
      const mainPath = join(scriptsDir, "main.puls");

      writeFileSync(manifestPath, `${JSON.stringify(manifestObj, null, 2)}\n`, "utf8");
      writeFileSync(formatPath, `${formatBlock!.code}\n`, "utf8");
      writeFileSync(mainPath, `${mainBlock!.code}\n`, "utf8");

      // Formatting and linting pass with 0 errors.
      expect(() => formatPulsarScript(formatBlock!.code)).not.toThrow();
      expect(() => formatPulsarScript(mainBlock!.code)).not.toThrow();

      const lintDiags = lintPulsarScript(mainBlock!.code, { filePath: mainPath, manifestPath });
      expect(lintDiags.filter((d) => d.severity === "error")).toEqual([]);

      // Link multi-file bundle and compile with debug metadata.
      const linked = linkModule(mainPath);
      new SemanticAnalyzer().analyze(linked.statements);
      const chunk = BytecodeCompiler.compile(linked.statements, linked.sources, { debug: true });
      const bytecodeJson = JSON.stringify(withHeader(chunk, mainBlock!.code, pkg.version));

      // Verify on TypeScript Interpreter with synthetic directory containing subdir + 4 files.
      const mockIo: IOBridge = {
        readFile: () => null,
        writeFile: () => false,
        exists: (p) => p === "/docs",
        listDir: (): Array<FileEntry & { dir: boolean; modified: number }> => [
          { name: "nested", isDir: true, dir: true, size: 99999, modified: 1732406400000 },
          { name: "small.txt", isDir: false, dir: false, size: 120, modified: 1732406400000 },
          { name: "huge.bin", isDir: false, dir: false, size: 4096, modified: 1732406400000 },
          { name: "medium.md", isDir: false, dir: false, size: 1024, modified: 1732406400000 },
          { name: "notes.txt", isDir: false, dir: false, size: 2048, modified: 1732406400000 },
        ],
        stat: () => null,
        deleteFile: () => false,
        mkdir: () => false,
        rename: () => false,
        copy: () => false,
      };
      const interp = new Interpreter({ io: mockIo });
      interp.interpret(linked.statements, linked.sources);
      const tsOut = toHost(interp.callHandler("largestFiles", ["/docs"])) as {
        dir: string;
        count: number;
        files: { name: string; size: number }[];
        summary: string;
      };
      expect(tsOut.count).toBe(3);
      expect(tsOut.files.map((f) => f.name)).toEqual(["huge.bin", "notes.txt", "medium.md"]);
      expect(tsOut.summary).toContain("\n- huge.bin (4 KiB)\n");

      // Verify identical handler execution on Go WASM VM against seeded Mock FS.
      const client = await loadPulsarWasmVM();
      const session = client.createSession(bytecodeJson, {
        mockHost: true,
        seedMockFS: true,
        capabilities: { "fs.read": true },
      });
      try {
        expect(session.handlers).toContain("largestFiles");
        const wasmCall = await session.dispatchHandler("largestFiles", ["/docs"]);
        expect(wasmCall.ok).toBe(true);
        const res = wasmCall.result as {
          dir: string;
          count: number;
          files: { name: string; size: number }[];
          summary: string;
        };
        expect(res.dir).toBe("/docs");
        expect(res.count).toBe(3);
        expect(res.files.map((f) => f.name)).toEqual(["notes.md", "spec.md", "todo.txt"]);
        expect(res.summary).toContain("Top files in /docs:\n- notes.md");
      } finally {
        session.dispose();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("generated docs portal, site-data, and Script Studio WASM debugger wiring are valid", () => {
    const requiredFiles = [
      "site/docs.html",
      "site/docs.js",
      "site/docs-data.js",
      "site/site-data.js",
      "site/pulsar-runtime.js",
      "site/pulsarvm.wasm",
      "site/pulsarvm.wasm.br",
      "site/pulsarvm.wasm.gz",
      "site/wasm_exec.js",
      "site/index.html",
      "site/app.js",
      "site/styles.css",
    ];
    for (const rel of requiredFiles) {
      expect(statSync(resolve(rel)).size).toBeGreaterThan(0);
    }
    const rawWasmBytes = statSync(resolve("site/pulsarvm.wasm")).size;
    const brWasmBytes = statSync(resolve("site/pulsarvm.wasm.br")).size;
    const gzWasmBytes = statSync(resolve("site/pulsarvm.wasm.gz")).size;
    expect(rawWasmBytes).toBeLessThan(4 * 1024 * 1024);
    expect(brWasmBytes).toBeLessThan(gzWasmBytes);
    expect(gzWasmBytes).toBeLessThan(rawWasmBytes);

    // Syntax check browser JS scripts without executing DOM queries.
    const appJs = readFileSync(resolve("site/app.js"), "utf8");
    const docsJs = readFileSync(resolve("site/docs.js"), "utf8");
    expect(() => new Function(appJs)).not.toThrow();
    expect(() => new Function(docsJs)).not.toThrow();

    // Evaluate generated docs data bundle cleanly in an isolated global object.
    const docsDataCode = readFileSync(resolve("site/docs-data.js"), "utf8");
    const sandbox: Record<string, unknown> = {};
    new Function("globalThis", docsDataCode)(sandbox);
    const payload = sandbox.PULSARSCRIPT_DOCS_DATA as {
      meta: {
        totalFunctions: number;
        coreFunctions: number;
        hostFunctions: number;
        conformanceCount: number;
      };
      functions: unknown[];
      conformanceExamples: { id: string; code: string; expected: string }[];
      manifestSchema: { required: string[] };
      sdkReference: { bridgeGlobals: unknown[]; cliCommands: unknown[] };
      specMarkdown: string;
      guideMarkdown: string;
    };

    expect(payload.meta.totalFunctions).toBe(97);
    expect(payload.meta.coreFunctions).toBe(77);
    expect(payload.meta.hostFunctions).toBe(20);
    expect(payload.meta.conformanceCount).toBeGreaterThanOrEqual(285);
    expect(payload.functions.length).toBe(97);
    expect(payload.conformanceExamples.length).toBeGreaterThanOrEqual(20);
    expect(payload.manifestSchema.required).toEqual(["id", "name", "version", "ui", "permissions"]);
    expect(payload.sdkReference.bridgeGlobals.length).toBeGreaterThanOrEqual(4);
    expect(payload.sdkReference.cliCommands.length).toBeGreaterThanOrEqual(5);
    expect(payload.specMarkdown).toContain("PulsarScript");
    expect(payload.guideMarkdown).toContain("largestFiles");

    const docsHtml = readFileSync(resolve("site/docs.html"), "utf8");
    expect(docsHtml).toContain('href="#docs-main"');
    expect(docsHtml).toContain("docs-global-search");
    expect(docsHtml).toContain("./docs-data.js");
    expect(docsHtml).toContain("./docs.js");
    expect(docsHtml.match(/<h1\b/g)?.length).toBe(1);

    const indexHtml = readFileSync(resolve("site/index.html"), "utf8");
    expect(indexHtml).toContain('./docs.html');
    expect(indexHtml).toContain('focusgroup="tablist nomemory"');
    expect(indexHtml).toContain('hidden="until-found"');
    expect(indexHtml).toContain("studio-engine-badge");
    expect(indexHtml).toContain("studio-mock-badge");
    expect(indexHtml).toContain("studio-time-bar");
    expect(indexHtml).toContain("debug-breakpoints");
    expect(indexHtml).toContain("debug-paused-badge");
    expect(indexHtml).toContain("studio-gutter");
    expect(indexHtml).toContain("studio-line-count");
    expect(indexHtml).toContain("hero-lines-pill");
    expect(indexHtml).toContain("has-lines");
  });
});

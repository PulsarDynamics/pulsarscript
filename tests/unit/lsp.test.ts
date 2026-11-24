import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { HOST_FUNCTIONS } from "../../HostApi";
import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
  getFormattingEdits,
  getHover,
  getSignatureHelp,
  pathToUri,
} from "../../lsp/analysis";
import { encodeLspMessage, LspMessageReader, type JsonRpcMessage } from "../../lsp/protocol";

const REPO = resolve(import.meta.dir, "..", "..");

describe("LSP protocol & intelligence (DX-03)", () => {
  test("LspMessageReader handles split chunks, UTF-8 byte lengths, and batched frames", () => {
    const m1 = encodeLspMessage({ jsonrpc: "2.0", id: 1, method: "ping", params: { txt: "héllo 🚀" } });
    const m2 = encodeLspMessage({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    const combined = Buffer.concat([m1, m2]);

    const reader = new LspMessageReader();
    const out: JsonRpcMessage[] = [];
    // Feed byte-by-byte / tiny irregular slices.
    for (let i = 0; i < combined.length; i += 7) {
      out.push(...reader.push(combined.subarray(i, i + 7)));
    }
    expect(out).toHaveLength(2);
    expect((out[0] as { params: { txt: string } }).params.txt).toBe("héllo 🚀");
    expect((out[1] as { id: number }).id).toBe(2);
  });

  test("completions include all 97 vm/hostapi.json entries with types and user symbols", () => {
    const src = `function myHelper(x) { return x + 1; }\nconst MY_CONST = 9;\n`;
    const items = getCompletions("file:///app/main.puls", src, { line: 2, character: 0 });
    const labels = new Set(items.map((i) => i.label));
    expect(labels.has("myHelper")).toBe(true);
    expect(labels.has("MY_CONST")).toBe(true);

    for (const fn of HOST_FUNCTIONS) {
      const item = items.find((i) => i.label === fn.name);
      expect(item).toBeDefined();
      expect(item!.detail).toContain(fn.returns);
      expect(item!.documentation?.value).toContain(fn.doc);
    }
    expect(HOST_FUNCTIONS.length).toBe(97);
  });

  test("diagnostics combine syntax, semantic, and manifest capability checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulsar-lsp-diag-"));
    try {
      writeFileSync(
        join(dir, "AppManifest.json"),
        JSON.stringify({
          id: "com.example.lsp",
          name: "LSP App",
          version: "1.0.0",
          ui: { entry: "ui/index.html" },
          permissions: { scopes: ["fs.read"] },
        })
      );
      const mainPath = join(dir, "main.puls");
      const src = `var dead = 1;\nfsWrite("a.txt", "hi");\n`;
      const diags = getDiagnostics(pathToUri(mainPath), src);
      expect(diags.some((d) => d.code === "no-unused-vars")).toBe(true);
      expect(diags.some((d) => d.code === "missing-capability" && d.severity === 1)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hover, signatureHelp, documentSymbols, formatting, and cross-file go-to-definition", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulsar-lsp-def-"));
    try {
      const utilPath = join(dir, "util.puls");
      const mainPath = join(dir, "main.puls");
      writeFileSync(
        utilPath,
        `export const FACTOR = 10;\nexport function scale(n) {\n  return n * FACTOR;\n}\n`
      );
      const mainSrc = `import { scale as mulScale } from "./util.puls";\nfunction run(v) {\n  var localVal = mulScale(v);\n  return fsRead(string(localVal));\n}\nprint(run(3));\n`;
      writeFileSync(mainPath, mainSrc);
      const mainUri = pathToUri(mainPath);
      const utilUri = pathToUri(utilPath);

      // Cross-file definition on imported call `mulScale(v)` (line 2, col ~18)
      const defCross = getDefinition(mainUri, mainSrc, { line: 2, character: 18 });
      expect(defCross).not.toBeNull();
      expect(defCross!.uri).toBe(utilUri);
      expect(defCross!.range.start.line).toBe(1);

      // Cross-file definition on module string `"./util.puls"` (line 0, col 38)
      const defMod = getDefinition(mainUri, mainSrc, { line: 0, character: 38 });
      expect(defMod?.uri).toBe(utilUri);

      // Same-file definition on `localVal` inside `string(localVal)` (line 3, col 25)
      const defLocal = getDefinition(mainUri, mainSrc, { line: 3, character: 25 });
      expect(defLocal?.uri).toBe(mainUri);
      expect(defLocal?.range.start.line).toBe(2);

      // Hover on host function `fsRead` (line 3, col 10)
      const hoverHost = getHover(mainUri, mainSrc, { line: 3, character: 10 });
      expect(hoverHost?.contents.value).toContain("fsRead(path: string): string|nil");
      expect(hoverHost?.contents.value).toContain("fs.read");

      // Hover on imported symbol `mulScale`
      const hoverImport = getHover(mainUri, mainSrc, { line: 2, character: 19 });
      expect(hoverImport?.contents.value).toContain("function scale(n)");

      // SignatureHelp inside `fsRead(`
      const sig = getSignatureHelp(mainUri, 'fsRead("a.txt', { line: 0, character: 12 });
      expect(sig?.signatures[0].label).toContain("fsRead(path: string)");

      // DocumentSymbols
      const syms = getDocumentSymbols(mainSrc);
      expect(syms.map((s) => s.name)).toContain("run");

      // Formatting edits
      const edits = getFormattingEdits("var  x=1+2;\n");
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toBe("var x = 1 + 2;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stdio LSP server handles initialize, didOpen, completion, hover, formatting, and shutdown", async () => {
    const proc = Bun.spawn(["bun", "run", join(REPO, "lsp", "server.ts")], {
      cwd: REPO,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = new LspMessageReader();
    const received: JsonRpcMessage[] = [];
    const pumpPromise = (async () => {
      const streamReader = proc.stdout.getReader();
      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;
        if (value) received.push(...reader.push(value));
      }
    })();

    const send = (msg: JsonRpcMessage) => {
      proc.stdin.write(encodeLspMessage(msg));
    };

    const waitFor = async (pred: (m: JsonRpcMessage) => boolean, timeoutMs = 4000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = received.find(pred);
        if (found) return found;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for LSP message. Received: ${JSON.stringify(received)}`);
    };

    const docUri = "file:///tmp/stdio-test.puls";
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null, capabilities: {} } });
    const initResp = await waitFor((m) => "id" in m && m.id === 1);
    expect((initResp as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("pulsarscript-lsp");

    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: docUri, languageId: "pulsarscript", version: 1, text: "var  x=len(\"hi\");\nprint(x);\n" } },
    });
    const diagNotif = await waitFor((m) => "method" in m && m.method === "textDocument/publishDiagnostics");
    expect((diagNotif as { params: { diagnostics: unknown[] } }).params.diagnostics).toEqual([]);

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/completion",
      params: { textDocument: { uri: docUri }, position: { line: 1, character: 0 } },
    });
    const compResp = await waitFor((m) => "id" in m && m.id === 2);
    expect((compResp as { result: { items: unknown[] } }).result.items.length).toBeGreaterThanOrEqual(HOST_FUNCTIONS.length);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "textDocument/hover",
      params: { textDocument: { uri: docUri }, position: { line: 0, character: 8 } },
    });
    const hoverResp = await waitFor((m) => "id" in m && m.id === 3);
    expect((hoverResp as { result: { contents: { value: string } } }).result.contents.value).toContain("len(value:");

    send({
      jsonrpc: "2.0",
      id: 4,
      method: "textDocument/formatting",
      params: { textDocument: { uri: docUri }, options: { tabSize: 2, insertSpaces: true } },
    });
    const fmtResp = await waitFor((m) => "id" in m && m.id === 4);
    expect((fmtResp as { result: { newText: string }[] }).result[0].newText).toBe('var x = len("hi");\nprint(x);\n');

    send({ jsonrpc: "2.0", id: 5, method: "shutdown" });
    await waitFor((m) => "id" in m && m.id === 5);
    send({ jsonrpc: "2.0", method: "exit" });
    await proc.stdin.end();
    const exitCode = await proc.exited;
    await pumpPromise;
    expect(exitCode).toBe(0);
  });

  test("VS Code extension metadata and TextMate grammar are valid and cover all 97 host/core APIs", () => {
    const extPkg = JSON.parse(readFileSync(join(REPO, "editors", "vscode", "package.json"), "utf8"));
    expect(extPkg.contributes.languages[0].extensions).toContain(".puls");
    expect(extPkg.contributes.jsonValidation[0].fileMatch).toBe("AppManifest.json");

    const langConfig = JSON.parse(readFileSync(join(REPO, "editors", "vscode", "language-configuration.json"), "utf8"));
    expect(langConfig.comments.lineComment).toBe("//");

    const grammar = JSON.parse(
      readFileSync(join(REPO, "editors", "vscode", "syntaxes", "pulsarscript.tmLanguage.json"), "utf8")
    );
    const builtinsMatch = grammar.repository.builtins.match as string;
    const re = new RegExp(builtinsMatch);
    for (const fn of HOST_FUNCTIONS) {
      expect(re.test(fn.name)).toBe(true);
    }
  });
});

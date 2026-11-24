import { describe, expect, test } from "bun:test";
import { Lexer } from "../../Lexer";
import { Parser } from "../../Parser";
import { SemanticAnalyzer } from "../../SemanticAnalyzer";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { withHeader } from "../../Bytecode";
import pkg from "../../package.json";
import { loadPulsarWasmVM } from "../../wasm/pulsar-wasm";

function compileToBytecode(source: string, debug = false): string {
  const tokens = new Lexer(source).scanTokens();
  const stmts = new Parser(tokens).parse();
  new SemanticAnalyzer().analyze(stmts);
  const chunk = BytecodeCompiler.compile(stmts, ["wasm-test.puls"], { debug });
  return JSON.stringify(withHeader(chunk, source, pkg.version));
}

describe("Go VM WebAssembly runtime (DX-04)", () => {
  test("verifies modules, disassembles bytecode, and runs scripts with exact parity", async () => {
    const client = await loadPulsarWasmVM();
    const src = `
function makeAdder(x) {
  return function(y) { return x + y; };
}
var add5 = makeAdder(5);
print(add5(7));
print(arrayJoin(arrayMap([1, 2, 3], function(n) { return string(n * 2); }), "-"));
`;
    const bc = compileToBytecode(src);
    const verified = client.verifyModule(bc);
    expect(verified.ok).toBe(true);
    expect(verified.version).toBe(3);

    const disasm = client.disassemble(bc);
    expect(disasm.ok).toBe(true);
    expect(disasm.text).toContain("CLOSURE");
    expect(disasm.text).toContain("HALT");

    const res = await client.runBytecode(bc);
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("ok");
    expect(res.prints).toEqual(["12", "2-4-6"]);
    expect(res.stats.steps).toBeGreaterThan(0);
  });

  test("executes sleep(ms) without blocking Go WASM and enforces memory & step budgets", async () => {
    const client = await loadPulsarWasmVM();

    const sleepBc = compileToBytecode('print("before"); sleep(10); print("after");');
    const sleepRes = await client.runBytecode(sleepBc, { autoResumeYield: true });
    expect(sleepRes.ok).toBe(true);
    expect(sleepRes.prints).toEqual(["before", "after"]);

    const memBombBc = compileToBytecode('var s = "a"; try { for (var i = 0; i < 30; i += 1) { s = s + s; } } catch (e) { print("caught"); }');
    const memRes = await client.runBytecode(memBombBc, { maxStringBytes: 1024 });
    expect(memRes.ok).toBe(false);
    expect(memRes.stage).toBe("memory");
    expect(memRes.error).toContain("memory limit");

    const loopBc = compileToBytecode('try { while (true) {} } catch (e) { print("caught"); }');
    const loopRes = await client.runBytecode(loopBc, { maxSteps: 500 });
    expect(loopRes.ok).toBe(false);
    expect(loopRes.stage).toBe("budget");
  });

  test("runs in-memory mock host stand-ins with capability gating and labeled mock calls", async () => {
    const client = await loadPulsarWasmVM();
    const src = `
var files = fsList("/docs");
kvSet("count", len(files));
print(len(files));
print(kvGet("count"));
`;
    const bc = compileToBytecode(src);
    const allowed = await client.runBytecode(bc, {
      mockHost: true,
      seedMockFS: true,
      capabilities: { "fs.read": true, kv: true },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.prints).toEqual(["3", "3"]);
    expect(allowed.mockHostCalls?.length).toBe(3);
    expect(allowed.mockHostCalls?.every((c) => c.mock === true)).toBe(true);

    const denied = await client.runBytecode(bc, {
      mockHost: true,
      seedMockFS: true,
      capabilities: { "fs.read": false, kv: true },
    });
    expect(denied.ok).toBe(false);
    expect(denied.stage).toBe("capability");
    expect(denied.deniedCalls).toEqual(["fsList -> requires fs.read"]);
  });

  test("supports stateful RPC handler sessions", async () => {
    const client = await loadPulsarWasmVM();
    const src = `
function greet(name) {
  return "Hello, " + name;
}
registerHandler("greet", greet);
`;
    const sess = client.createSession(compileToBytecode(src));
    try {
      expect(sess.handlers).toEqual(["greet"]);
      const out = await sess.dispatchHandler("greet", ["Pulsar"]);
      expect(out.ok).toBe(true);
      expect(out.result).toBe("Hello, Pulsar");
    } finally {
      sess.dispose();
    }
  });
});

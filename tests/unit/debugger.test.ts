import { describe, expect, test } from "bun:test";
import { Lexer } from "../../Lexer";
import { Parser } from "../../Parser";
import { SemanticAnalyzer } from "../../SemanticAnalyzer";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { withHeader } from "../../Bytecode";
import pkg from "../../package.json";
import { loadPulsarWasmVM } from "../../wasm/pulsar-wasm";

function compileDebug(source: string): string {
  const tokens = new Lexer(source).scanTokens();
  const stmts = new Parser(tokens).parse();
  new SemanticAnalyzer().analyze(stmts);
  const chunk = BytecodeCompiler.compile(stmts, ["debug.puls"], { debug: true });
  return JSON.stringify(withHeader(chunk, source, pkg.version));
}

describe("Go WASM Debugger (DX-05)", () => {
  test("stops at breakpoints, inspects named locals & globals, and steps over/in/out", async () => {
    const src = [
      'var factor = 2;',              // line 1
      'function multiply(n) {',       // line 2
      '  var res = n * factor;',      // line 3
      '  return res;',                // line 4
      '}',                            // line 5
      'function run() {',             // line 6
      '  var input = 21;',            // line 7
      '  var answer = multiply(input);', // line 8
      '  print(answer);',             // line 9
      '}',                            // line 10
      'run();',                       // line 11
    ].join("\n");

    const client = await loadPulsarWasmVM();
    const dbg = client.createDebugSession(compileDebug(src));
    try {
      const bps = dbg.setBreakpoints([{ line: 8 }]);
      expect(bps.ok).toBe(true);
      expect(bps.breakpoints).toEqual([{ line: 8 }]);

      let res = await dbg.continue();
      expect(res.snapshot.reason).toBe("breakpoint");
      expect(res.snapshot.line).toBe(8);
      expect(res.snapshot.frames[0].name).toBe("run");
      expect(res.snapshot.frames[0].locals.find((l) => l.name === "input")?.value).toBe("21");
      expect(res.snapshot.globals.find((g) => g.name === "factor")?.value).toBe("2");

      // Step over multiply(input) onto line 9
      res = await dbg.stepOver();
      expect(res.snapshot.reason).toBe("step");
      expect(res.snapshot.line).toBe(9);
      expect(res.snapshot.frames[0].locals.find((l) => l.name === "answer")?.value).toBe("42");

      // Finish execution
      res = await dbg.continue();
      expect(res.snapshot.halted).toBe(true);
      expect(res.prints).toEqual(["42"]);
    } finally {
      dbg.dispose();
    }
  });

  test("steps into a function call and steps back out", async () => {
    const src = [
      'function inner(v) {',  // line 1
      '  var doubled = v + v;', // line 2
      '  return doubled;',    // line 3
      '}',                    // line 4
      'function outer() {',   // line 5
      '  var x = inner(5);',  // line 6
      '  return x;',          // line 7
      '}',                    // line 8
      'print(outer());',      // line 9
    ].join("\n");

    const client = await loadPulsarWasmVM();
    const dbg = client.createDebugSession(compileDebug(src));
    try {
      dbg.setBreakpoints([{ line: 6 }]);
      let res = await dbg.continue();
      expect(res.snapshot.line).toBe(6);

      res = await dbg.stepIn();
      expect(res.snapshot.frames[0].name).toBe("inner");

      res = await dbg.stepOver();
      expect(res.snapshot.line).toBe(3);
      expect(res.snapshot.frames[0].locals.find((l) => l.name === "doubled")?.value).toBe("10");

      res = await dbg.stepOut();
      expect(res.snapshot.frames[0].name).toBe("outer");

      res = await dbg.continue();
      expect(res.snapshot.halted).toBe(true);
      expect(res.prints).toEqual(["10"]);
    } finally {
      dbg.dispose();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { Lexer } from "../../Lexer";
import { ParseError, Parser } from "../../Parser";
import { SemanticAnalyzer, SemanticError } from "../../SemanticAnalyzer";
import { BytecodeCompiler } from "../../BytecodeCompiler";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKEN_FRAGMENTS = [
  "var", "const", "function", "return", "if", "else", "while", "for", "of",
  "try", "catch", "break", "continue", "print", "import", "export", "from", "as",
  "true", "false", "nil", "x", "y", "f", "0", "1", "1e3", "0xff", "0x", "1e",
  "\"hi\"", "\"a\\nb\"", "\"\\u{41}\"", "\"\\q\"", "`hi ${", "}`", "`${1}`",
  "+", "-", "*", "/", "%", "=", "==", "!=", "<", "<=", ">", ">=", "&&", "||", "!", "?", ":",
  "(", ")", "{", "}", "[", "]", ",", ".", ";", "/* comment */", "/*", "// line\n", "\n", " ",
];

const SEEDS = [
  'var a = 1 + 2; print(a);',
  'function f(x) { if (x > 0) return f(x - 1); return 0; } print(f(3));',
  'try { var o = {a: [1, 2]}; o.a[len(o.a)] = 3; } catch (e) { print(e.stack); }',
  'var fn = function(k) { return `val=${k}`; }; print(fn(0x10));',
  'for (var ch of "abc") { if (ch == "b") continue; print(ch); }',
  'import { a as b } from "./mod.puls"; export const c = 1e2;',
];

function checkCompilePipeline(src: string): void {
  try {
    const tokens = new Lexer(src).scanTokens();
    const stmts = new Parser(tokens).parse();
    new SemanticAnalyzer().analyze(stmts);
    BytecodeCompiler.compile(stmts);
  } catch (err: any) {
    if (err instanceof ParseError || err instanceof SemanticError) {
      expect(typeof err.token?.line).toBe("number");
      expect(err.token.line).toBeGreaterThanOrEqual(1);
      return;
    }
    throw err;
  }
}

describe("parser and compiler fuzzing (LANG-14)", () => {
  test("handles 1,500 mutated/fuzzed programs without crashing and reports valid line numbers", () => {
    const rng = mulberry32(0x5eed14);
    for (let i = 0; i < 1500; i++) {
      let src: string;
      const mode = i % 3;
      if (mode === 0) {
        // Random token-soup concatenation
        const count = 1 + Math.floor(rng() * 30);
        const parts: string[] = [];
        for (let k = 0; k < count; k++) {
          parts.push(TOKEN_FRAGMENTS[Math.floor(rng() * TOKEN_FRAGMENTS.length)]);
        }
        src = parts.join(rng() < 0.7 ? " " : "");
      } else if (mode === 1) {
        // Mutate a valid seed by inserting/deleting/slicing characters
        const base = SEEDS[Math.floor(rng() * SEEDS.length)];
        const cut1 = Math.floor(rng() * base.length);
        const cut2 = cut1 + Math.floor(rng() * Math.max(1, base.length - cut1));
        const inj = TOKEN_FRAGMENTS[Math.floor(rng() * TOKEN_FRAGMENTS.length)];
        src = base.slice(0, cut1) + inj + base.slice(cut2);
      } else {
        // Truncate/nest brackets, templates, or block structures deeply (bounded)
        const depth = 1 + Math.floor(rng() * 20);
        const op = rng() < 0.33 ? "{ " : rng() < 0.5 ? "(" : "`${";
        const cl = op === "{ " ? "}" : op === "(" ? ")" : "}`";
        src = op.repeat(depth) + "1" + (rng() < 0.5 ? cl.repeat(depth) : cl.repeat(Math.max(0, depth - 2)));
      }
      checkCompilePipeline(src);
    }
  });
});

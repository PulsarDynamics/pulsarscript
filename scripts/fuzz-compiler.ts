// Standalone parser and compiler fuzzer CLI (LANG-14).
// Run: bun run scripts/fuzz-compiler.ts --iterations 25000 --seed 0x5eed14
import { Lexer } from "../Lexer";
import { ParseError, Parser } from "../Parser";
import { SemanticAnalyzer, SemanticError } from "../SemanticAnalyzer";
import { BytecodeCompiler } from "../BytecodeCompiler";

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
  'function make(s) { return function(n) { s += n; return s; }; } print(make(1)(2));',
];

const args = process.argv.slice(2);
const getOpt = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const iterations = Number(getOpt("--iterations") ?? 25_000);
const seedRaw = getOpt("--seed") ?? "0x5eed14";
const seed = Number.parseInt(seedRaw, seedRaw.startsWith("0x") ? 16 : 10) || 0x5eed14;

if (!Number.isFinite(iterations) || iterations < 1) {
  console.error("Invalid --iterations count.");
  process.exit(2);
}

const rng = mulberry32(seed);
const startMs = performance.now();
let compiledOk = 0;
let rejectedCleanly = 0;

for (let i = 0; i < iterations; i++) {
  let src: string;
  const mode = i % 3;
  if (mode === 0) {
    const count = 1 + Math.floor(rng() * 32);
    const parts: string[] = [];
    for (let k = 0; k < count; k++) {
      parts.push(TOKEN_FRAGMENTS[Math.floor(rng() * TOKEN_FRAGMENTS.length)]);
    }
    src = parts.join(rng() < 0.7 ? " " : "");
  } else if (mode === 1) {
    const base = SEEDS[Math.floor(rng() * SEEDS.length)];
    const cut1 = Math.floor(rng() * base.length);
    const cut2 = cut1 + Math.floor(rng() * Math.max(1, base.length - cut1));
    const inj = TOKEN_FRAGMENTS[Math.floor(rng() * TOKEN_FRAGMENTS.length)];
    src = base.slice(0, cut1) + inj + base.slice(cut2);
  } else {
    const depth = 1 + Math.floor(rng() * 20);
    const op = rng() < 0.33 ? "{ " : rng() < 0.5 ? "(" : "`${";
    const cl = op === "{ " ? "}" : op === "(" ? ")" : "}`";
    src = op.repeat(depth) + "1" + (rng() < 0.5 ? cl.repeat(depth) : cl.repeat(Math.max(0, depth - 2)));
  }

  try {
    const tokens = new Lexer(src).scanTokens();
    const stmts = new Parser(tokens).parse();
    new SemanticAnalyzer().analyze(stmts);
    BytecodeCompiler.compile(stmts);
    compiledOk++;
  } catch (err: unknown) {
    if (err instanceof ParseError || err instanceof SemanticError) {
      if (typeof err.token?.line !== "number" || err.token.line < 1) {
        console.error(`Iteration ${i}: rejected without valid line number:`, err.message);
        console.error("Source:", JSON.stringify(src));
        process.exit(1);
      }
      rejectedCleanly++;
      continue;
    }
    console.error(`Iteration ${i}: unexpected crash:`, err);
    console.error("Source:", JSON.stringify(src));
    process.exit(1);
  }
}

const elapsedMs = Math.round(performance.now() - startMs);
console.log(
  `Fuzzed ${iterations} programs (seed=0x${seed.toString(16)}) in ${elapsedMs}ms: ${compiledOk} compiled, ${rejectedCleanly} cleanly rejected with line numbers.`
);

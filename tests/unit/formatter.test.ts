import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Lexer } from "../../Lexer";
import { Parser } from "../../Parser";
import { SemanticAnalyzer } from "../../SemanticAnalyzer";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { BudgetError, Interpreter, MemoryLimitError, RuntimeError } from "../../Interpreter";
import { ImportStmt } from "../../classes/ImportStmt";
import { ExportStmt } from "../../classes/ExportStmt";
import { formatPulsarScript } from "../../tools/formatter";

const REPO = resolve(import.meta.dir, "..", "..");
const CONFORMANCE_DIR = join(REPO, "tests", "conformance");

function collectPulsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectPulsFiles(full));
    else if (name.endsWith(".puls")) out.push(full);
  }
  return out.sort();
}

function runSourceCaptured(source: string): string[] {
  const tokens = new Lexer(source).scanTokens();
  const stmts = new Parser(tokens).parse();
  new SemanticAnalyzer().analyze(stmts);
  BytecodeCompiler.compile(stmts);

  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  const interp = new Interpreter({
    io: {
      readFile: () => null,
      writeFile: () => true,
      listDir: () => [],
      rename: () => true,
      kvGet: () => null,
      kvSet: () => true,
    },
    events: {
      emit: () => null,
      poll: () => null,
    },
  });
  try {
    interp.interpret(stmts);
  } catch (err: unknown) {
    if (err instanceof MemoryLimitError || err instanceof BudgetError || err instanceof RuntimeError) {
      lines.push(`!error: ${err.name}`);
    } else {
      throw err;
    }
  } finally {
    console.log = origLog;
  }
  return lines;
}

describe("formatter (DX-01)", () => {
  test("every parseable conformance case is idempotent and preserves execution semantics", () => {
    const files = collectPulsFiles(CONFORMANCE_DIR);
    let tested = 0;

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const expFile = file.replace(/\.puls$/, ".expected");
      const exp = existsSync(expFile) ? readFileSync(expFile, "utf8") : "";
      if (exp.includes("!error: parse")) continue;

      let stmts;
      try {
        stmts = new Parser(new Lexer(src).scanTokens()).parse();
      } catch {
        continue;
      }

      const once = formatPulsarScript(src);
      const twice = formatPulsarScript(once);
      expect(twice).toBe(once);
      tested++;

      // Skip runtime comparison for multi-file module imports, compile/semantic error tests,
      // error_lines (which explicitly prints source line numbers that shift on reformatting),
      // and long-running budget exhaustion / sleep loops (checked structurally below).
      const hasModules = stmts.some((s) => s instanceof ImportStmt || s instanceof ExportStmt);
      const isLineSensitive = file.endsWith("error_lines.puls");
      const isErrorOrBudgetCase =
        exp.includes("!error") ||
        file.includes("limits/") ||
        file.includes("events/sleep_");
      if (!hasModules && !isErrorOrBudgetCase && !isLineSensitive) {
        expect(runSourceCaptured(once)).toEqual(runSourceCaptured(src));
      } else {
        if (isLineSensitive) {
          // Formatted error_lines.puls still runs cleanly and reports valid positive line numbers.
          const formattedOut = runSourceCaptured(once);
          expect(formattedOut).toHaveLength(6);
          expect(formattedOut.every((n) => Number(n) >= 1)).toBe(true);
        }
        // Still verify formatted source re-parses cleanly.
        expect(() => new Parser(new Lexer(once).scanTokens()).parse()).not.toThrow();
      }
    }

    expect(tested).toBeGreaterThan(240);
  });

  test("preserves comments, blank lines, trailing comments, and empty block comments", () => {
    const src = `// File header


/* Multi-line
 * block comment */
function   demo(a,b){
  // leading inside
  var x = a+b; // trailing


  if(x>0){
    // inside if
    return x;
  }else if(x==0){
    return 0;
  }else{
    return -1;
  }
}

function emptyWithComment() {
  // todo
}
`;
    const once = formatPulsarScript(src);
    const twice = formatPulsarScript(once);
    expect(twice).toBe(once);
    expect(once).toContain("// File header");
    expect(once).toContain("/* Multi-line\n * block comment */");
    expect(once).toContain("// leading inside");
    expect(once).toContain("var x = a + b; // trailing");
    expect(once).toContain("} else if (x == 0) {");
    expect(once).toContain("function emptyWithComment() {\n  // todo\n}");
    expect(once).not.toContain("\n\n\n");
  });

  test("formats compound assignments, ternary, templates, hex/scientific numbers, and modules", () => {
    const src = `import{a,b as c}from"./util.puls";
export const N=0xff;
export var rate=1.5e-2;
var total=0;total+=10;total-=2;
var arr=[1,2,3];
arr[len(arr)-1]+=5;
var msg=\`hi \${a} and \${c>0?"pos":"neg"}\`;
var obj={"k-1":1,plain:2,"var":3};
export {total as out};
`;
    const once = formatPulsarScript(src);
    const twice = formatPulsarScript(once);
    expect(twice).toBe(once);
    expect(once).toContain('import { a, b as c } from "./util.puls";');
    expect(once).toContain("export const N = 0xff;");
    expect(once).toContain("export var rate = 1.5e-2;");
    expect(once).toContain("total += 10;");
    expect(once).toContain("arr[len(arr) - 1] += 5;");
    expect(once).toContain('var obj = { "k-1": 1, plain: 2, "var": 3 };');
    expect(once).toContain("export { total as out };");
  });

  test("preserves binary precedence, string concat grouping, and double unary negation", () => {
    const src = `print("a" + (1 + 2));
print(1 + 2 * 3);
print((1 + 2) * 3);
var x = -(-5);
`;
    const once = formatPulsarScript(src);
    expect(formatPulsarScript(once)).toBe(once);
    expect(runSourceCaptured(once)).toEqual(["a3", "7", "9"]);
  });

  test("CLI --check and --write flags work end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulsar-fmt-"));
    try {
      const f = join(dir, "sample.puls");
      writeFileSync(f, "var   x=1+2;\nprint( x );\n", "utf8");

      const check1 = Bun.spawnSync(["bun", "run", join(REPO, "fmt.ts"), "--check", f], { cwd: REPO });
      expect(check1.exitCode).toBe(1);

      const writeRes = Bun.spawnSync(["bun", "run", join(REPO, "fmt.ts"), "--write", f], { cwd: REPO });
      expect(writeRes.exitCode).toBe(0);

      const check2 = Bun.spawnSync(["bun", "run", join(REPO, "fmt.ts"), "--check", f], { cwd: REPO });
      expect(check2.exitCode).toBe(0);
      expect(readFileSync(f, "utf8")).toBe("var x = 1 + 2;\nprint(x);\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

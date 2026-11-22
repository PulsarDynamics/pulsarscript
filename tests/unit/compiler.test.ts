import { describe, expect, test } from "bun:test";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Lexer } from "../../Lexer";
import { Parser } from "../../Parser";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { Opcode, type Chunk } from "../../Bytecode";

const GOLDEN = join(dirname(new URL(import.meta.url).pathname), "..", "golden");
const UPDATE = !!process.env.UPDATE_GOLDEN;

const compile = (src: string): Chunk => BytecodeCompiler.compile(new Parser(new Lexer(src).scanTokens()).parse());

// Operand count per opcode, as emitted by BytecodeCompiler today. CALL carries two operands
// (function address, argument count); vmrun's disassembler decodes only one (defect D9).
const OPERANDS: Partial<Record<Opcode, number>> = {
  [Opcode.CONST]: 1,
  [Opcode.DEFINE_GLOBAL]: 1,
  [Opcode.GET_GLOBAL]: 1,
  [Opcode.SET_GLOBAL]: 1,
  [Opcode.GET_LOCAL]: 1,
  [Opcode.SET_LOCAL]: 1,
  [Opcode.JUMP]: 1,
  [Opcode.JUMP_IF_FALSE]: 1,
  [Opcode.CALL]: 2,
  [Opcode.HOST_CALL]: 2,
  [Opcode.ENTER_BLOCK]: 1,
  [Opcode.EXIT_BLOCK]: 1,
  [Opcode.TRY_PUSH]: 1,
  [Opcode.NEW_ARRAY]: 1,
  [Opcode.NEW_OBJECT]: 1,
};

/** Walk the code stream instruction by instruction; throws on an unknown opcode. */
function decode(chunk: Chunk): { at: number; op: Opcode; args: number[] }[] {
  const out: { at: number; op: Opcode; args: number[] }[] = [];
  let ip = 0;
  while (ip < chunk.code.length) {
    const op = chunk.code[ip] as Opcode;
    if (Opcode[op] === undefined) throw new Error(`unknown opcode ${op} at ${ip}`);
    const n = OPERANDS[op] ?? 0;
    out.push({ at: ip, op, args: chunk.code.slice(ip + 1, ip + 1 + n) });
    ip += 1 + n;
  }
  return out;
}

describe("bytecode format", () => {
  test("opcode numbers are stable (changing one is a breaking format change)", () => {
    const table = Object.fromEntries(
      Object.entries(Opcode).filter(([k]) => isNaN(Number(k))) as [string, number][]
    );
    expect(table).toMatchSnapshot();
  });
});

describe("compiler: golden bytecode", () => {
  const sources = readdirSync(GOLDEN).filter((f) => f.endsWith(".puls")).sort();

  test("golden directory has cases", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const file of sources) {
    test(file, async () => {
      const chunk = compile(await Bun.file(join(GOLDEN, file)).text());
      const goldenPath = join(GOLDEN, file.replace(/\.puls$/, ".bytecode.golden.json"));
      const actual = JSON.stringify(chunk, null, 2) + "\n";
      if (UPDATE || !existsSync(goldenPath)) {
        await Bun.write(goldenPath, actual);
        if (!UPDATE) throw new Error(`created missing golden ${goldenPath}; review and commit it`);
        return;
      }
      expect(actual).toBe(await Bun.file(goldenPath).text());
    });
  }
});

describe("compiler: structural invariants", () => {
  const programs = readdirSync(GOLDEN).filter((f) => f.endsWith(".puls"));

  for (const file of programs) {
    test(`${file}: decodes cleanly, operands in range, ends in HALT`, async () => {
      const chunk = compile(await Bun.file(join(GOLDEN, file)).text());
      const ins = decode(chunk);
      const starts = new Set(ins.map((i) => i.at));
      expect(ins.at(-1)?.op).toBe(Opcode.HALT);
      for (const i of ins) {
        if (i.op === Opcode.CONST || i.op === Opcode.GET_GLOBAL || i.op === Opcode.SET_GLOBAL || i.op === Opcode.DEFINE_GLOBAL || i.op === Opcode.HOST_CALL) {
          expect(i.args[0]).toBeLessThan(chunk.constants.length);
        }
        if (i.op === Opcode.CALL) {
          expect(starts.has(i.args[0])).toBe(true);
        }
      }
      for (const fn of chunk.functions ?? []) {
        expect(starts.has(fn.address)).toBe(true);
      }
    });
  }

  test("line map has one entry per code slot", () => {
    const chunk = compile("var a = 1;\nprint(a);\n");
    expect(chunk.lineMap).toHaveLength(chunk.code.length);
  });

  test("function table records name, arity and locals", () => {
    const chunk = compile("function f(a, b) { var c = a; return c; }\n");
    expect(chunk.functions).toHaveLength(1);
    const [fn] = chunk.functions!;
    expect(fn.name).toBe("f");
    expect(fn.arity).toBe(2);
    expect(fn.locals).toBe(3);
  });

  test("top-level var compiles to DEFINE_GLOBAL; functions read it with GET_GLOBAL (D1)", () => {
    const ops = decode(compile("var x = 1;\nfunction f() { return x; }\n")).map((i) => i.op);
    expect(ops).toContain(Opcode.DEFINE_GLOBAL);
    expect(ops).toContain(Opcode.GET_GLOBAL);
    expect(ops).not.toContain(Opcode.SET_LOCAL);
  });

  test("vars in blocks, functions and try blocks stay local (D1)", () => {
    for (const src of ["{ var b = 1; print(b); }", "function f() { var c = 1; return c; }", "try { var t = 1; } catch (e) { }"]) {
      const ops = decode(compile(src)).map((i) => i.op);
      expect(ops).not.toContain(Opcode.DEFINE_GLOBAL);
    }
  });

  test("unknown names and duplicate globals are compile-time errors (D3)", () => {
    expect(() => compile("print(nope);")).toThrow("Variable is not defined.");
    expect(() => compile("nope = 1;")).toThrow("Cannot assign to undefined variable.");
    expect(() => compile("var x = 1;\nvar x = 2;")).toThrow("already declared");
  });

  test("a call to a later-declared function compiles as CALL to its address (D2)", () => {
    const chunk = compile("function a() { return b(); }\nfunction b() { return 1; }\n");
    const ins = decode(chunk);
    expect(ins.map((i) => i.op)).not.toContain(Opcode.HOST_CALL);
    const call = ins.find((i) => i.op === Opcode.CALL)!;
    const b = chunk.functions!.find((f) => f.name === "b")!;
    expect(call.args).toEqual([b.address, 0]);
  });

  test("a top-level call before the declaration compiles as CALL (D2)", () => {
    const chunk = compile("print(f());\nfunction f() { return 1; }\n");
    const call = decode(chunk).find((i) => i.op === Opcode.CALL)!;
    expect(call.args[0]).toBe(chunk.functions![0].address);
  });

  test("unknown names still compile as host calls", () => {
    expect(decode(compile("print(typeOf(1));\n")).map((i) => i.op)).toContain(Opcode.HOST_CALL);
  });
});

describe("compiler: line map (D18)", () => {
  test("has one entry per code word for every golden program", async () => {
    for (const file of readdirSync(GOLDEN).filter((f) => f.endsWith(".puls"))) {
      const chunk = compile(await Bun.file(join(GOLDEN, file)).text());
      expect(chunk.lineMap!.length).toBe(chunk.code.length);
    }
  });

  test("maps each instruction to the line of the node that emitted it", () => {
    const chunk = compile("var a = 1;\nprint(\n  a /\n  0);\nif (a > 0) {\n  a = 2;\n}\n");
    const div = chunk.code.indexOf(Opcode.DIV);
    expect(chunk.lineMap![div]).toBe(3);
    const print = chunk.code.indexOf(Opcode.PRINT);
    expect(chunk.lineMap![print]).toBe(2);
    const jif = chunk.code.indexOf(Opcode.JUMP_IF_FALSE);
    expect(chunk.lineMap![jif]).toBe(5);
    const setGlobal = chunk.code.indexOf(Opcode.SET_GLOBAL);
    expect(chunk.lineMap![setGlobal]).toBe(6);
  });
});

describe("bytecode header (A5)", () => {
  test("withHeader puts format, version, compiler and source hash first", async () => {
    const { withHeader, BYTECODE_FORMAT, BYTECODE_VERSION, sourceHash } = await import("../../Bytecode");
    const src = "print(1);";
    const file = withHeader(compile(src), src, "9.9.9");
    expect(Object.keys(file).slice(0, 4)).toEqual(["format", "version", "compiler", "sourceHash"]);
    expect(file.format).toBe(BYTECODE_FORMAT);
    expect(file.version).toBe(BYTECODE_VERSION);
    expect(file.compiler).toBe("pulsarscript 9.9.9");
    expect(file.sourceHash).toBe(sourceHash(src));
    expect(file.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sourceHash(src + " ")).not.toBe(file.sourceHash);
  });
});

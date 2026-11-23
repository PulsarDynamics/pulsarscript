import { describe, expect, test } from "bun:test";
import { Lexer } from "../../Lexer";
import { Parser, ParseError } from "../../Parser";
import { Binary } from "../../classes/Binary";
import { Literal } from "../../classes/Literal";
import { ExpressionStmt } from "../../classes/ExpressionStmt";
import { VarStmt } from "../../classes/VarStmt";
import { Assign } from "../../classes/Assign";
import { IfStmt } from "../../classes/IfStmt";
import { WhileStmt } from "../../classes/WhileStmt";
import { FunctionStmt } from "../../classes/FunctionStmt";
import { TryCatchStmt } from "../../classes/TryCatchStmt";
import { ArrayExpr } from "../../classes/ArrayExpr";
import { ObjectExpr } from "../../classes/ObjectExpr";
import { Call } from "../../classes/Call";
import { Variable } from "../../classes/Variable";
import type { Expr } from "../../interfaces/Expr";

const parse = (src: string) => new Parser(new Lexer(src).scanTokens()).parse();
const expr = (src: string): Expr => (parse(src + ";")[0] as ExpressionStmt).expression;

// Render an expression tree as a fully parenthesised string to check precedence.
function show(e: Expr): string {
  if (e instanceof Binary) return `(${show(e.left)} ${e.operator.lexeme} ${show(e.right)})`;
  if (e instanceof Literal) return String(e.value);
  if (e instanceof Variable) return e.name.lexeme;
  if (e instanceof Assign) return `(${e.name.lexeme} = ${show(e.value)})`;
  if (e instanceof Call) return `${show(e.callee)}(${e.arguments.map(show).join(", ")})`;
  return e.constructor.name;
}

describe("parser: expressions", () => {
  test("multiplication binds tighter than addition", () => {
    expect(show(expr("1 + 2 * 3"))).toBe("(1 + (2 * 3))");
  });

  test("binary operators are left-associative", () => {
    expect(show(expr("10 - 2 - 3"))).toBe("((10 - 2) - 3)");
  });

  test("comparison binds looser than arithmetic", () => {
    expect(show(expr("1 + 2 < 4"))).toBe("((1 + 2) < 4)");
  });

  test("assignment is right-associative", () => {
    expect(show(expr("a = b = 1"))).toBe("(a = (b = 1))");
  });

  test("calls take comma-separated arguments", () => {
    expect(show(expr("f(1, x, 2 + 3)"))).toBe("f(1, x, (2 + 3))");
  });

  test("array and object literals", () => {
    const a = expr("[1, 2, 3]");
    expect(a).toBeInstanceOf(ArrayExpr);
    expect((a as ArrayExpr).elements).toHaveLength(3);
    const o = expr("({name: 1, v: 2})");
    // Grouping wraps the object; unwrap one level.
    const inner = (o as any).expression ?? o;
    expect(inner).toBeInstanceOf(ObjectExpr);
    expect((inner as ObjectExpr).properties.map((p) => p.key)).toEqual(["name", "v"]);
  });
});

describe("parser: statements", () => {
  test("var declaration with and without initializer", () => {
    const [a, b] = parse("var a = 1; var b;");
    expect(a).toBeInstanceOf(VarStmt);
    expect((a as VarStmt).name.lexeme).toBe("a");
    expect((b as VarStmt).initializer).toBeNull();
  });

  test("if with else", () => {
    const [s] = parse("if (x) print(1); else print(2);");
    expect(s).toBeInstanceOf(IfStmt);
    expect((s as IfStmt).elseBranch).not.toBeNull();
  });

  test("while loop", () => {
    expect(parse("while (true) {}")[0]).toBeInstanceOf(WhileStmt);
  });

  test("function declaration records params and body", () => {
    const [f] = parse("function add(a, b) { return a + b; }");
    expect(f).toBeInstanceOf(FunctionStmt);
    expect((f as FunctionStmt).params.map((p) => p.lexeme)).toEqual(["a", "b"]);
    expect((f as FunctionStmt).body).toHaveLength(1);
  });

  test("try/catch with a catch parameter", () => {
    const [t] = parse("try { f(); } catch (e) { print(e); }");
    expect(t).toBeInstanceOf(TryCatchStmt);
    expect((t as TryCatchStmt).catchParam).toBe("e");
  });
});

describe("parser: errors (D13)", () => {
  const fail = (src: string): ParseError => {
    try {
      parse(src);
    } catch (e) {
      if (e instanceof ParseError) return e;
      throw e;
    }
    throw new Error("expected a ParseError");
  };

  test("a syntax error stops parsing with its line and message", () => {
    const err = fail("print(1);\nvar x = ;\nprint(2);");
    expect(err.token.line).toBe(2);
    expect(err.message).toBe("Expect expression.");
  });

  test("every syntax error is reported in one pass", () => {
    const err = fail("var = 1;\nprint(2);\nprint((3);\n1 = 2;");
    expect(err.errors.map((e) => e.token.line)).toEqual([1, 3, 4]);
    expect(err.errors[0]).toBe(err);
  });

  test("errors that do not abort the rule are still reported", () => {
    expect(fail("1 = 2;").message).toBe("Invalid assignment target.");
    expect(fail("try { print(1); }").message).toBe("Expect 'catch' after try block.");
    const args = Array.from({ length: 256 }, (_, i) => String(i)).join(", ");
    expect(fail(`f(${args});`).message).toBe("Can't have more than 255 arguments.");
  });

  test("scientific and hex literals parse, malformed ones are errors", () => {
    expect((expr("1e3") as Literal).value).toBe(1000);
    expect((expr("1.5e-2") as Literal).value).toBe(0.015);
    expect((expr("0xff") as Literal).value).toBe(255);
    expect(() => parse("print(1e);")).toThrow(/Invalid exponent/);
    expect(() => parse("print(0x);")).toThrow(/Invalid hex/);
  });

  test("valid programs still parse", () => {
    expect(parse("var x = 1;\nprint(x);")).toHaveLength(2);
  });
});

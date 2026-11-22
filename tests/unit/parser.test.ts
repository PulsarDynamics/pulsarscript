import { describe, expect, test } from "bun:test";
import { Lexer } from "../../Lexer";
import { Parser } from "../../Parser";
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

describe("parser: errors", () => {
  // D13: today the parser swallows every ParseError and replaces the statement with `nil;`.
  // These document the current behaviour; the todo tests describe the SPEC behaviour.
  test("current behaviour: a bad statement is silently replaced by `nil;` (D13)", () => {
    const stmts = parse("var x = ;\nprint(1);");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBeInstanceOf(ExpressionStmt);
    expect(((stmts[0] as ExpressionStmt).expression as Literal).value).toBeNull();
  });

  test.todo("SPEC: a syntax error is reported with its line and stops compilation (D13)");
  test.todo("SPEC: several syntax errors are all reported in one pass (D13)");
});

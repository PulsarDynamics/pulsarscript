import { describe, expect, test } from "bun:test";
import { HOST_FUNCTIONS, arityError, arityRange, lookupHostFunction } from "../../HostApi";
import { Lexer } from "../../Lexer";
import { Parser } from "../../Parser";
import { SemanticAnalyzer } from "../../SemanticAnalyzer";
import { BytecodeCompiler } from "../../BytecodeCompiler";
import { BudgetError, Interpreter, RuntimeError } from "../../Interpreter";

const parse = (src: string) => new Parser(new Lexer(src).scanTokens()).parse();

describe("host-call registry", () => {
  test("entries are well formed", () => {
    const names = new Set<string>();
    for (const fn of HOST_FUNCTIONS) {
      expect(names.has(fn.name)).toBe(false);
      names.add(fn.name);
      expect(["core", "host"]).toContain(fn.provider);
      fn.params.forEach((p, i) => {
        if (p.variadic) expect(i).toBe(fn.params.length - 1);
      });
    }
  });

  test("arity ranges", () => {
    expect(arityRange(lookupHostFunction("len")!)).toEqual({ min: 1, max: 1 });
    expect(arityRange(lookupHostFunction("arrayPush")!)).toEqual({ min: 2, max: Infinity });
    expect(arityRange(lookupHostFunction("emitEvent")!)).toEqual({ min: 0, max: 1 });
    expect(arityError(lookupHostFunction("len")!, 2)).toBe("len: expected 1 argument but got 2.");
  });

  test("unknown functions fail in the analyzer and the compiler (D3)", () => {
    const stmts = parse("try { notAFunction(); } catch (e) { }");
    expect(() => new SemanticAnalyzer().analyze(stmts)).toThrow("Unknown function 'notAFunction'.");
    expect(() => BytecodeCompiler.compile(stmts)).toThrow("Unknown function 'notAFunction'.");
  });

  test("every registry entry is a native in the interpreter", () => {
    const interp = new Interpreter();
    for (const fn of HOST_FUNCTIONS) {
      expect(() => interp.interpret(parse(`typeOf(${fn.name});`))).not.toThrow();
    }
  });
});

describe("budgets (D10)", () => {
  test("an infinite loop stops and cannot be caught", () => {
    const interp = new Interpreter({ limits: { maxSteps: 10_000 } });
    expect(() => interp.interpret(parse("try { while (true) { } } catch (e) { print(1); }"))).toThrow(BudgetError);
  });

  test("deep recursion is a catchable runtime error", () => {
    const interp = new Interpreter({ limits: { maxCallDepth: 50 } });
    expect(() => interp.interpret(parse("function f(n) { return f(n + 1); } f(0);"))).toThrow(RuntimeError);
  });

  test("handlers run with fresh budgets", () => {
    const interp = new Interpreter({ limits: { maxSteps: 1_000 } });
    interp.interpret(parse('function ping(x) { return concat("pong ", x); } registerHandler("ping", "ping");'));
    expect(interp.handlerNames()).toEqual(["ping"]);
    for (let i = 0; i < 5; i++) expect(interp.callHandler("ping", [i])).toBe(`pong ${i}`);
  });
});

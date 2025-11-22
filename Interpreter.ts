import type { Assign } from "./classes/Assign";
import type { Binary } from "./classes/Binary";
import type { BlockStmt } from "./classes/BlockStmt";
import type { Call } from "./classes/Call";
import type { ExpressionStmt } from "./classes/ExpressionStmt";
import type { ForStmt } from "./classes/ForStmt";
import { FunctionStmt } from "./classes/FunctionStmt";
import type { Grouping } from "./classes/Grouping";
import type { IfStmt } from "./classes/IfStmt";
import type { Literal } from "./classes/Literal";
import type { PrintStmt } from "./classes/PrintStmt";
import type { ReturnStmt } from "./classes/ReturnStmt";
import type { Unary } from "./classes/Unary";
import type { VarStmt } from "./classes/VarStmt";
import { Variable } from "./classes/Variable";
import type { WhileStmt } from "./classes/WhileStmt";
import { TokenType } from "./enums/TokenType";
import type { Expr } from "./interfaces/Expr";
import type { ExprVisitor } from "./interfaces/ExprVisitor";
import type { Stmt } from "./interfaces/Stmt";
import type { StmtVisitor } from "./interfaces/StmtVisitor";
import type { Token } from "./interfaces/Token";
import type { CallFrame } from "./ErrorReporter";

// Runtime error class
export class RuntimeError extends Error {
  token: Token;
  callStack: CallFrame[];

  constructor(token: Token, message: string, callStack: CallFrame[] = []) {
    super(message);
    this.token = token;
    this.callStack = callStack;
  }
}

// Return exception for function returns
class ReturnException extends Error {
  value: any;

  constructor(value: any) {
    super();
    this.value = value;
  }
}

// Environment for variable storage
class Environment {
  private values: Map<string, any> = new Map();
  enclosing: Environment | null;
  private interpreter: Interpreter | null;

  constructor(enclosing: Environment | null = null, interpreter: Interpreter | null = null) {
    this.enclosing = enclosing;
    this.interpreter = interpreter || enclosing?.interpreter || null;
  }

  define(name: string, value: any): void {
    this.values.set(name, value);
  }

  get(name: Token): any {
    if (this.values.has(name.lexeme)) {
      return this.values.get(name.lexeme);
    }

    if (this.enclosing !== null) {
      return this.enclosing.get(name);
    }

    const error = this.interpreter 
      ? this.interpreter.createRuntimeError(name, `Undefined variable '${name.lexeme}'.`)
      : new RuntimeError(name, `Undefined variable '${name.lexeme}'.`);
    throw error;
  }

  assign(name: Token, value: any): void {
    if (this.values.has(name.lexeme)) {
      this.values.set(name.lexeme, value);
      return;
    }

    if (this.enclosing !== null) {
      this.enclosing.assign(name, value);
      return;
    }

    const error = this.interpreter 
      ? this.interpreter.createRuntimeError(name, `Undefined variable '${name.lexeme}'.`)
      : new RuntimeError(name, `Undefined variable '${name.lexeme}'.`);
    throw error;
  }
}

// Callable interface for functions
interface PulsarCallable {
  arity(): number;
  call(interpreter: Interpreter, args: any[]): any;
  toString(): string;
}

// Function wrapper
class PulsarFunction implements PulsarCallable {
  private declaration: FunctionStmt;
  private closure: Environment;

  constructor(declaration: FunctionStmt, closure: Environment) {
    this.declaration = declaration;
    this.closure = closure;
  }

  arity(): number {
    return this.declaration.params.length;
  }

  call(interpreter: Interpreter, args: any[]): any {
    const environment = new Environment(this.closure);
    
    // Add this function call to the stack
    interpreter.pushCallFrame({
      functionName: this.declaration.name.lexeme,
      line: this.declaration.name.line
    });

    try {
      for (let i = 0; i < this.declaration.params.length; i++) {
        environment.define(this.declaration.params[i].lexeme, args[i]);
      }

      try {
        interpreter.executeBlock(this.declaration.body, environment);
      } catch (returnValue) {
        if (returnValue instanceof ReturnException) {
          return returnValue.value;
        }
        throw returnValue;
      }

      return null;
    } finally {
      // Remove from stack when function exits
      interpreter.popCallFrame();
    }
  }

  toString(): string {
    return `<fn ${this.declaration.name.lexeme}>`;
  }
}

// Main Interpreter class
type InterpreterOptions = { strictTypes?: boolean };

export class Interpreter implements ExprVisitor<any>, StmtVisitor<void> {
  private globals: Environment;
  private environment: Environment;
  private options: Required<InterpreterOptions> = { strictTypes: false };
  private callStack: CallFrame[] = [];

  constructor(options?: InterpreterOptions) {
    // Initialize globals with reference to this interpreter
    this.globals = new Environment(null, this);
    this.environment = this.globals;
    if (options) {
      this.options = { strictTypes: options.strictTypes ?? false };
    }
    // Register standard library (built-in) functions
    const defineNative = (name: string, arity: number, impl: (...args: any[]) => any) => {
      const native: PulsarCallable = {
        arity: () => arity,
        call: (_: Interpreter, args: any[]) => impl(...args),
        toString: () => `<native ${name}>`
      };
      this.globals.define(name, native);
    };

    const mkNativeToken = (name: string): Token => ({ type: TokenType.IDENTIFIER, lexeme: name, literal: null, line: 0 } as Token);
    const requireNumber = (name: string, v: any): number => {
      if (typeof v === 'number') return v;
      if (this.options.strictTypes) throw this.createRuntimeError(mkNativeToken(name), `${name}: expected number`);
      return Number(v);
    };
    const requireString = (name: string, v: any): string => {
      if (typeof v === 'string') return v;
      if (this.options.strictTypes) throw this.createRuntimeError(mkNativeToken(name), `${name}: expected string`);
      return String(v);
    };

    // Core / Types
    defineNative("typeOf", 1, (v) => {
      if (v === null) return "nil";
      const t = typeof v;
      if (t === "number" || t === "string" || t === "boolean") return t;
      return "object";
    });

    // Conversions
    defineNative("number", 1, (v) => {
      if (v === null) return null;
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "string") {
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
      }
      return null;
    });
    defineNative("string", 1, (v) => this.stringify(v));

    // Time / Random
    defineNative("clock", 0, () => Date.now());
    defineNative("random", 0, () => Math.random());
    defineNative("randomInt", 2, (min, max) => {
      const a = Math.floor(Number(min));
      const b = Math.floor(Number(max));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    });

    // Math
    defineNative("abs", 1, (n) => Math.abs(requireNumber("abs", n)));
    defineNative("floor", 1, (n) => Math.floor(requireNumber("floor", n)));
    defineNative("ceil", 1, (n) => Math.ceil(requireNumber("ceil", n)));
    defineNative("round", 1, (n) => Math.round(requireNumber("round", n)));
    defineNative("sqrt", 1, (n) => Math.sqrt(requireNumber("sqrt", n)));
    defineNative("pow", 2, (a, b) => Math.pow(requireNumber("pow", a), requireNumber("pow", b)));
    defineNative("min", 2, (a, b) => Math.min(requireNumber("min", a), requireNumber("min", b)));
    defineNative("max", 2, (a, b) => Math.max(requireNumber("max", a), requireNumber("max", b)));
    defineNative("clamp", 3, (n, lo, hi) => {
      const x = requireNumber("clamp", n), a = requireNumber("clamp", lo), b = requireNumber("clamp", hi);
      return Math.min(Math.max(x, a), b);
    });

    // Strings
    defineNative("len", 1, (s) => requireString("len", s).length);
    defineNative("toUpper", 1, (s) => requireString("toUpper", s).toUpperCase());
    defineNative("toLower", 1, (s) => requireString("toLower", s).toLowerCase());
    defineNative("trim", 1, (s) => requireString("trim", s).trim());
    defineNative("indexOf", 2, (s, sub) => requireString("indexOf", s).indexOf(requireString("indexOf", sub)));
    defineNative("substr", 3, (s, start, length) => {
      const str = requireString("substr", s);
      const iRaw = Number(start);
      const lenRaw = Number(length);
      if (!Number.isFinite(iRaw) || !Number.isFinite(lenRaw)) {
        throw this.createRuntimeError({ type: TokenType.IDENTIFIER, lexeme: "substr", literal: null, line: 0 } as Token, "substr: start and length must be finite numbers");
      }
      const i = Math.floor(iRaw);
      const len = Math.floor(lenRaw);
      if (i < 0) {
        throw this.createRuntimeError({ type: TokenType.IDENTIFIER, lexeme: "substr", literal: null, line: 0 } as Token, "substr: start index cannot be negative");
      }
      if (len < 0) {
        throw this.createRuntimeError({ type: TokenType.IDENTIFIER, lexeme: "substr", literal: null, line: 0 } as Token, "substr: length cannot be negative");
      }
      if (i >= str.length) {
        // Out of bounds start: return empty string (non-fatal) to mirror many languages
        return "";
      }
      return str.substring(i, Math.min(str.length, i + len));
    });

    // Variadic concatenation (explicit string building in strict mode)
    const concatToken = { type: TokenType.IDENTIFIER, lexeme: "concat", literal: null, line: 0 } as Token;
    const concatCallable: PulsarCallable = {
      arity: () => -1,
      call: (_: Interpreter, args: any[]) => {
        if (this.options.strictTypes) {
          // In strict mode: all args must be string or number explicitly; number gets stringified, others error.
          return args.map(a => {
            if (typeof a === 'string') return a;
            if (typeof a === 'number') return this.stringify(a);
            throw this.createRuntimeError(concatToken, "concat: arguments must be string or number in strict mode");
          }).join("");
        }
        // Non-strict: stringify everything.
        return args.map(a => this.stringify(a)).join("");
      },
      toString: () => `<native concat>`
    };
    this.globals.define("concat", concatCallable);

    // Safe parsing utilities
    defineNative("parseInt", 2, (s, base) => {
      if (typeof s === 'number') return Number.isInteger(s) ? s : null;
      const b = requireNumber("parseInt", base);
      if (!(b >= 2 && b <= 36)) return null;
      const str = requireString("parseInt", s).trim();
      const regex = b === 10 ? /^[+-]?\d+$/ : /^[+-]?[0-9a-z]+$/i;
      if (!regex.test(str)) return null;
      const n = parseInt(str, b);
      return Number.isNaN(n) ? null : n;
    });
    defineNative("parseFloat", 1, (s) => {
      if (typeof s === 'number') return s;
      const str = requireString("parseFloat", s).trim();
      // Strict float: no trailing junk
      if (!/^[+-]?(?:\d+\.\d+|\d+\.\d*|\.\d+|\d+)$/.test(str)) return null;
      const n = Number(str);
      return Number.isFinite(n) ? n : null;
    });
    defineNative("toNumberOr", 2, (s, def) => {
      if (typeof s === 'number') return s;
      if (typeof s === 'boolean') return s ? 1 : 0;
      if (typeof s === 'string') {
        const n = Number(s);
        return Number.isNaN(n) ? def : n;
      }
      return def;
    });
    defineNative("isInteger", 1, (n) => typeof n === 'number' && Number.isInteger(n));
    defineNative("isFinite", 1, (n) => typeof n === 'number' && Number.isFinite(n));
  }

  interpret(statements: Stmt[]): void {
    try {
      for (const statement of statements) {
        this.execute(statement);
      }
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw error;
      }
      throw error;
    }
  }

  // Statement visitors
  visitExpressionStmt(stmt: ExpressionStmt): void {
    this.evaluate(stmt.expression);
  }

  visitPrintStmt(stmt: PrintStmt): void {
    const value = this.evaluate(stmt.expression);
    console.log(this.stringify(value));
  }

  visitVarStmt(stmt: VarStmt): void {
    let value = null;
    if (stmt.initializer !== null) {
      value = this.evaluate(stmt.initializer);
    }
    this.environment.define(stmt.name.lexeme, value);
  }

  visitBlockStmt(stmt: BlockStmt): void {
    this.executeBlock(stmt.statements, new Environment(this.environment));
  }

  visitIfStmt(stmt: IfStmt): void {
    if (this.isTruthy(this.evaluate(stmt.condition))) {
      this.execute(stmt.thenBranch);
    } else if (stmt.elseBranch !== null) {
      this.execute(stmt.elseBranch);
    }
  }

  visitWhileStmt(stmt: WhileStmt): void {
    while (this.isTruthy(this.evaluate(stmt.condition))) {
      this.execute(stmt.body);
    }
  }

  visitForStmt(stmt: ForStmt): void {
    // Create a new scope for the for loop
    const environment = new Environment(this.environment);
    const previous = this.environment;
    try {
      this.environment = environment;

      // Execute initializer (if present)
      if (stmt.initializer !== null) {
        this.execute(stmt.initializer);
      }

      // Loop while condition is truthy (or forever if no condition)
      while (stmt.condition === null || this.isTruthy(this.evaluate(stmt.condition))) {
        this.execute(stmt.body);

        // Execute increment (if present)
        if (stmt.increment !== null) {
          this.evaluate(stmt.increment);
        }
      }
    } finally {
      this.environment = previous;
    }
  }

  visitFunctionStmt(stmt: FunctionStmt): void {
    const func = new PulsarFunction(stmt, this.environment);
    this.environment.define(stmt.name.lexeme, func);
  }

  visitReturnStmt(stmt: ReturnStmt): void {
    let value = null;
    if (stmt.value !== null) {
      value = this.evaluate(stmt.value);
    }
    throw new ReturnException(value);
  }

  // Expression visitors
  visitLiteralExpr(expr: Literal): any {
    return expr.value;
  }

  visitGroupingExpr(expr: Grouping): any {
    return this.evaluate(expr.expression);
  }

  visitUnaryExpr(expr: Unary): any {
    const right = this.evaluate(expr.right);

    switch (expr.operator.type) {
      case TokenType.MINUS:
        if (this.options.strictTypes) {
          this.checkNumberOperand(expr.operator, right);
          return - (right as number);
        }
        this.checkNumberOperand(expr.operator, right);
        return -Number(right);
      case TokenType.BANG:
        return !this.isTruthy(right);
    }

    return null;
  }

  visitBinaryExpr(expr: Binary): any {
    const left = this.evaluate(expr.left);
    const right = this.evaluate(expr.right);

    switch (expr.operator.type) {
      case TokenType.MINUS:
        if (this.options.strictTypes) {
          this.checkNumberOperands(expr.operator, left, right);
          return (left as number) - (right as number);
        }
        this.checkNumberOperands(expr.operator, left, right);
        return Number(left) - Number(right);
      case TokenType.PLUS:
        if (this.options.strictTypes) {
          if (typeof left === 'number' && typeof right === 'number') {
            return (left as number) + (right as number);
          }
          if (typeof left === 'string' && typeof right === 'string') {
            return (left as string) + (right as string);
          }
          throw this.createRuntimeError(expr.operator, "PLUS: operands must both be numbers or both be strings in strict mode.");
        } else {
          if (typeof left === 'number' && typeof right === 'number') {
            return Number(left) + Number(right);
          }
          if (typeof left === 'string' || typeof right === 'string') {
            return this.stringify(left) + this.stringify(right);
          }
          throw this.createRuntimeError(expr.operator, "Operands must be two numbers or strings.");
        }
      case TokenType.SLASH:
        if (this.options.strictTypes) {
          this.checkNumberOperands(expr.operator, left, right);
          if ((right as number) === 0) {
            throw this.createRuntimeError(expr.operator, "Division by zero.");
          }
          return (left as number) / (right as number);
        }
        this.checkNumberOperands(expr.operator, left, right);
        if (Number(right) === 0) {
          throw this.createRuntimeError(expr.operator, "Division by zero.");
        }
        return Number(left) / Number(right);
      case TokenType.STAR:
        if (this.options.strictTypes) {
          this.checkNumberOperands(expr.operator, left, right);
          return (left as number) * (right as number);
        }
        this.checkNumberOperands(expr.operator, left, right);
        return Number(left) * Number(right);
      case TokenType.GREATER:
        if (this.options.strictTypes) {
          this.checkNumberOperands(expr.operator, left, right);
          return (left as number) > (right as number);
        }
        this.checkNumberOperands(expr.operator, left, right);
        return Number(left) > Number(right);
      case TokenType.GREATER_EQUAL:
        if (this.options.strictTypes) {
          this.checkNumberOperands(expr.operator, left, right);
          return (left as number) >= (right as number);
        }
        this.checkNumberOperands(expr.operator, left, right);
        return Number(left) >= Number(right);
      case TokenType.LESS:
        if (this.options.strictTypes) {
          this.checkNumberOperands(expr.operator, left, right);
          return (left as number) < (right as number);
        }
        this.checkNumberOperands(expr.operator, left, right);
        return Number(left) < Number(right);
      case TokenType.LESS_EQUAL:
        if (this.options.strictTypes) {
          this.checkNumberOperands(expr.operator, left, right);
          return (left as number) <= (right as number);
        }
        this.checkNumberOperands(expr.operator, left, right);
        return Number(left) <= Number(right);
      case TokenType.BANG_EQUAL:
        return !this.isEqual(left, right);
      case TokenType.EQUAL_EQUAL:
        return this.isEqual(left, right);
      case TokenType.AND:
        if (!this.isTruthy(left)) return left;
        return right;
      case TokenType.OR:
        if (this.isTruthy(left)) return left;
        return right;
    }

    return null;
  }

  visitVariableExpr(expr: Variable): any {
    return this.environment.get(expr.name);
  }

  visitAssignExpr(expr: Assign): any {
    const value = this.evaluate(expr.value);
    this.environment.assign(expr.name, value);
    return value;
  }

  visitCallExpr(expr: Call): any {
    const callee = this.evaluate(expr.callee);

    const args: any[] = [];
    for (const argument of expr.arguments) {
      args.push(this.evaluate(argument));
    }

    if (!this.isCallable(callee)) {
      throw this.createRuntimeError(expr.paren, "Can only call functions and classes.");
    }

    const func = callee as PulsarCallable;
    const expected = func.arity();
    if (expected >= 0 && args.length !== expected) {
      throw this.createRuntimeError(
        expr.paren,
        `Expected ${expected} arguments but got ${args.length}.`
      );
    }

    return func.call(this, args);
  }

  // Helper methods
  executeBlock(statements: Stmt[], environment: Environment): void {
    const previous = this.environment;
    try {
      this.environment = environment;
      for (const statement of statements) {
        this.execute(statement);
      }
    } finally {
      this.environment = previous;
    }
  }

  pushCallFrame(frame: CallFrame): void {
    this.callStack.push(frame);
  }

  popCallFrame(): void {
    this.callStack.pop();
  }

  createRuntimeError(token: Token, message: string): RuntimeError {
    return new RuntimeError(token, message, [...this.callStack]);
  }

  private execute(stmt: Stmt): void {
    stmt.accept(this);
  }

  private evaluate(expr: Expr): any {
    return expr.accept(this);
  }

  private isTruthy(value: any): boolean {
    if (value === null) return false;
    if (typeof value === 'boolean') return value;
    return true;
  }

  private isEqual(a: any, b: any): boolean {
    return a === b;
  }

  private isCallable(value: any): boolean {
    return value && typeof value === 'object' && 'call' in value && 'arity' in value;
  }

  private checkNumberOperand(operator: Token, operand: any): void {
    if (typeof operand === 'number') return;
    throw this.createRuntimeError(operator, "Operand must be a number.");
  }

  private checkNumberOperands(operator: Token, left: any, right: any): void {
    if (typeof left === 'number' && typeof right === 'number') return;
    throw this.createRuntimeError(operator, "Operands must be numbers.");
  }

  private stringify(value: any): string {
    if (value === null) return "nil";
    if (typeof value === 'number') {
      let text = value.toString();
      if (text.endsWith('.0')) {
        text = text.substring(0, text.length - 2);
      }
      return text;
    }
    if (typeof value === 'boolean') return value.toString();
    if (typeof value === 'string') return value;
    if (this.isCallable(value)) {
      return (value as PulsarCallable).toString();
    }
    return String(value);
  }
}

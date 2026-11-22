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
import type { ArrayExpr } from "./classes/ArrayExpr";
import type { ObjectExpr } from "./classes/ObjectExpr";
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
import type { IPCBridge, IPCEnvelope, IPCResponse } from "./interfaces/IPC";
import type { IOBridge } from "./interfaces/IO";
import { ErrorExpr } from "./classes/ErrorExpr";
import { TryCatchStmt } from "./classes/TryCatchStmt";
import type { CallFrame } from "./ErrorReporter";
import { fromHost, isArray, isObject, sortedKeys, stringify, toHost, toNumber, typeName, valuesEqual } from "./Values";
import { HOST_FUNCTIONS, arityError, arityRange, lookupHostFunction, type HostFunction } from "./HostApi";

const RE_FLOAT = /^[+-]?(?:\d+\.\d+|\d+\.\d*|\.\d+|\d+)$/;

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

/**
 * A step or time budget ran out (D10). It is a RuntimeError so hosts report it like one, but
 * try/catch never catches it: a script must not be able to outlive its budget.
 */
export class BudgetError extends RuntimeError {
  constructor(message: string) {
    super({ type: TokenType.IDENTIFIER, lexeme: "", literal: null, line: 0 } as Token, message);
  }
}

// Return exception for function returns. It is control flow, not an error: try/catch must
// never catch it (D19).
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

  getOwn(name: string): any {
    return this.values.get(name);
  }

  get(name: Token): any {
    const value = this.values.get(name.lexeme);
    if (value !== undefined) {
      return value;
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
    
    // Add this function call to the stack (enforces the call-depth limit and the step budget)
    interpreter.enterCall(this.declaration.name, {
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

/**
 * Execution limits (SPEC §7, D10). Every run is bounded by default so a runaway script stops
 * with an uncatchable budget error instead of hanging its host. 0 or Infinity disables a limit.
 * A step is one statement, loop iteration or call; the Go VM counts bytecode instructions, so
 * the two step counts are comparable only roughly.
 */
export interface ExecutionLimits {
  maxSteps?: number;
  timeoutMs?: number;
  maxCallDepth?: number;
}

export const DEFAULT_LIMITS: Required<ExecutionLimits> = {
  maxSteps: 10_000_000,
  timeoutMs: 10_000,
  maxCallDepth: 256,
};

/** Bridge for emitEvent/pollEvent (host provided). */
export interface EventBridge {
  emit(payload: unknown): unknown;
  poll(): unknown;
}

export type InterpreterOptions = {
  strictTypes?: boolean;
  ipc?: IPCBridge;
  defaultDeviceId?: string;
  defaultProcessId?: string;
  io?: IOBridge;
  events?: EventBridge;
  limits?: ExecutionLimits;
};

const KIND_OF = (v: any): string => typeName(v);

export class Interpreter implements ExprVisitor<any>, StmtVisitor<void> {
  private globals: Environment;
  private environment: Environment;
  // strictTypes defaults to true: arithmetic on non-numbers is a runtime error, as on the VM
  // (SPEC §4.2). strictTypes: false makes built-ins coerce their arguments instead.
  private options: { strictTypes: boolean; ipc?: IPCBridge; defaultDeviceId?: string; defaultProcessId?: string; io?: IOBridge; events?: EventBridge };
  private limits: Required<ExecutionLimits>;
  private steps = 0;
  private deadline = Infinity;
  private callStack: CallFrame[] = [];
  private ipcBridge?: IPCBridge;
  private ipcDefaults: { deviceId?: string; processId?: string } = {};
  private handlers: Map<string, PulsarFunction> = new Map();
  private rngState: number | null = null;

  constructor(options: InterpreterOptions = {}) {
    // Initialize globals with reference to this interpreter
    this.globals = new Environment(null, this);
    this.environment = this.globals;
    this.options = {
      strictTypes: options.strictTypes ?? true,
      ipc: options.ipc,
      defaultDeviceId: options.defaultDeviceId,
      defaultProcessId: options.defaultProcessId,
      io: options.io,
      events: options.events,
    };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.ipcBridge = this.options.ipc;
    this.ipcDefaults.deviceId = this.options.defaultDeviceId ?? this.ipcBridge?.defaultDeviceId;
    this.ipcDefaults.processId = this.options.defaultProcessId ?? this.ipcBridge?.defaultProcessId;

    const nativeToken = (name: string): Token => ({ type: TokenType.IDENTIFIER, lexeme: name, literal: null, line: 0 } as Token);
    const fail = (name: string, message: string): never => {
      throw this.createRuntimeError(nativeToken(name), `${name}: ${message}`);
    };
    const num = (name: string, v: any): number => (typeof v === "number" ? v : this.options.strictTypes ? fail(name, "expected number") : Number(v));
    const str = (name: string, v: any): string => (typeof v === "string" ? v : this.options.strictTypes ? fail(name, "expected string") : this.stringify(v));
    const ensureIO = (name: string): IOBridge => this.options.io ?? fail(name, "IO bridge not configured");
    const ensureIPC = (name: string): IPCBridge => this.ipcBridge ?? fail(name, "IPC bridge not configured");
    const ensureEvents = (name: string): EventBridge => this.options.events ?? fail(name, "event bridge not configured");
    // Host results become language values; async results stay promises (resolved by the host).
    const fromHostResult = (val: any) => (val instanceof Promise ? val.then(fromHost) : fromHost(val));
    const codePoints = (s: string) => [...s];
    const key = (k: any): string => this.stringify(k);
    const arrayArg = (name: string, v: any): any[] => (isArray(v) ? v : fail(name, "expected array"));
    const objectArg = (name: string, v: any): Map<string, any> => (isObject(v) ? v : fail(name, "expected object"));
    const random = (): number => {
      if (this.rngState === null) return Math.random();
      // mulberry32: small, fast, good enough for games and tests; not cryptographic.
      let t = (this.rngState = (this.rngState + 0x6d2b79f5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const parseIntStrict = (s: any, base: any): number | null => {
      if (typeof s === "number") return Number.isInteger(s) ? s : null;
      const b = num("parseInt", base);
      if (!Number.isInteger(b) || b < 2 || b > 36) return null;
      let text = str("parseInt", s).trim();
      let sign = 1;
      if (text.startsWith("+") || text.startsWith("-")) {
        if (text[0] === "-") sign = -1;
        text = text.slice(1);
      }
      if (text === "") return null;
      let value = 0;
      for (const ch of text.toLowerCase()) {
        const d = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : ch >= "a" && ch <= "z" ? ch.charCodeAt(0) - 87 : 99;
        if (d >= b) return null;
        value = value * b + d;
      }
      return sign * value;
    };
    const normalizeEnvelope = (name: string, channel: string, op: string, payload: any): IPCEnvelope => {
      const bridge = ensureIPC(name);
      const dev = this.ipcDefaults.deviceId ?? bridge.defaultDeviceId;
      const proc = this.ipcDefaults.processId ?? bridge.defaultProcessId;
      if (!dev) fail(name, "deviceId is required");
      if (!proc) fail(name, "processId is required");
      return {
        v: 1,
        deviceId: String(dev),
        processId: String(proc),
        channel,
        op,
        payload: toHost(payload),
        nonce: this.generateNonce(),
        ts: Date.now(),
      };
    };
    const handleIPCResponse = (name: string, resp: IPCResponse | void) => {
      if (!resp) return null;
      if (resp.error) fail(name, resp.error.message ? `${resp.error.code}: ${resp.error.message}` : resp.error.code);
      return fromHost(resp.result ?? null);
    };

    // One implementation per hostapi.json entry (SPEC §8). Arity and argument types are checked
    // from the registry before an implementation runs (see defineRegistered below).
    const impls: Record<string, (...args: any[]) => any> = {
      // Core / types
      typeOf: (v) => typeName(v),
      string: (v) => this.stringify(v),
      number: (v) => toNumber(v),
      concat: (...args) => args.map((a) => this.stringify(a)).join(""),
      len: (v) => (isArray(v) ? v.length : codePoints(str("len", v)).length),
      // Math
      abs: (n) => Math.abs(num("abs", n)),
      floor: (n) => Math.floor(num("floor", n)),
      ceil: (n) => Math.ceil(num("ceil", n)),
      round: (n) => Math.round(num("round", n)),
      sqrt: (n) => Math.sqrt(num("sqrt", n)),
      pow: (a, b) => Math.pow(num("pow", a), num("pow", b)),
      min: (a, b) => Math.min(num("min", a), num("min", b)),
      max: (a, b) => Math.max(num("max", a), num("max", b)),
      clamp: (n, lo, hi) => Math.min(Math.max(num("clamp", n), num("clamp", lo)), num("clamp", hi)),
      isInteger: (n) => typeof n === "number" && Number.isInteger(n),
      isFinite: (n) => typeof n === "number" && Number.isFinite(n),
      // Strings (indices and lengths count code points, like len)
      toUpper: (s) => str("toUpper", s).toUpperCase(),
      toLower: (s) => str("toLower", s).toLowerCase(),
      trim: (s) => str("trim", s).trim(),
      indexOf: (s, sub) => {
        const text = str("indexOf", s);
        const i = text.indexOf(str("indexOf", sub));
        return i < 0 ? -1 : codePoints(text.slice(0, i)).length;
      },
      substr: (s, start, length) => {
        const chars = codePoints(str("substr", s));
        const i = Math.trunc(num("substr", start));
        const n = Math.trunc(num("substr", length));
        if (!Number.isFinite(i) || !Number.isFinite(n)) fail("substr", "start and length must be finite numbers");
        if (i < 0) fail("substr", "start index cannot be negative");
        if (n < 0) fail("substr", "length cannot be negative");
        return chars.slice(i, i + n).join("");
      },
      // Parsing
      parseInt: (s, base) => parseIntStrict(s, base),
      parseFloat: (s) => {
        if (typeof s === "number") return s;
        const text = str("parseFloat", s).trim();
        if (!RE_FLOAT.test(text)) return null;
        const n = Number(text);
        return Number.isFinite(n) ? n : null;
      },
      toNumberOr: (v, fallback) => toNumber(v) ?? fallback,
      // Time / random
      clock: () => Date.now(),
      random: () => random(),
      randomInt: (a, b) => {
        const x = Math.trunc(num("randomInt", a));
        const y = Math.trunc(num("randomInt", b));
        const lo = Math.min(x, y);
        const hi = Math.max(x, y);
        return lo + Math.floor(random() * (hi - lo + 1));
      },
      randomSeed: (seed) => {
        this.rngState = Math.trunc(num("randomSeed", seed)) | 0;
        return null;
      },
      // Arrays and objects (SPEC §3.3): values; every function returns a new value.
      arrayLen: (a) => arrayArg("arrayLen", a).length,
      arrayPush: (a, ...values) => [...arrayArg("arrayPush", a), ...values],
      arrayPop: (a) => {
        const arr = arrayArg("arrayPop", a);
        return arr.length === 0 ? null : arr[arr.length - 1];
      },
      arraySlice: (a, start, end) => {
        const arr = arrayArg("arraySlice", a);
        const lo = Math.max(0, Math.trunc(num("arraySlice", start)));
        const hi = Math.min(arr.length, Math.trunc(num("arraySlice", end)));
        return lo > hi ? [] : arr.slice(lo, hi);
      },
      arrayConcat: (...arrays) => arrays.flatMap((a) => arrayArg("arrayConcat", a)),
      arrayIndexOf: (a, v) => arrayArg("arrayIndexOf", a).findIndex((x) => valuesEqual(x, v)),
      objKeys: (o) => sortedKeys(objectArg("objKeys", o)),
      objValues: (o) => {
        const obj = objectArg("objValues", o);
        return sortedKeys(obj).map((k) => obj.get(k));
      },
      objHas: (o, k) => objectArg("objHas", o).has(key(k)),
      objGet: (o, k) => objectArg("objGet", o).get(key(k)) ?? null,
      objSet: (o, k, v) => new Map(objectArg("objSet", o)).set(key(k), v),
      // Handlers
      registerHandler: (name, fnName) => {
        const fn = this.globals.getOwn(str("registerHandler", fnName));
        if (!(fn instanceof PulsarFunction)) fail("registerHandler", `handler function not found: ${fnName}`);
        this.handlers.set(str("registerHandler", name), fn as PulsarFunction);
        return null;
      },
      // Host: key-value store
      kvGet: (k) => {
        const io = ensureIO("kvGet");
        if (!io.kvGet) fail("kvGet", "kv storage not available");
        return fromHostResult(io.kvGet!(k));
      },
      kvSet: (k, v) => {
        const io = ensureIO("kvSet");
        if (!io.kvSet) fail("kvSet", "kv storage not available");
        return fromHostResult(io.kvSet!(k, toHost(v)));
      },
      kvDelete: (k) => {
        const io = ensureIO("kvDelete");
        if (!io.kvDelete) fail("kvDelete", "kv storage not available");
        return fromHostResult(io.kvDelete!(k));
      },
      // Host: sandboxed files
      fsRead: (p) => fromHostResult(ensureIO("fsRead").readFile(p)),
      fsWrite: (p, data) => fromHostResult(ensureIO("fsWrite").writeFile(p, this.stringify(data))),
      fsList: (p) => fromHostResult(ensureIO("fsList").listDir(p)),
      fsStat: (p) => {
        const io = ensureIO("fsStat");
        if (!io.stat) fail("fsStat", "not supported by this host");
        return fromHostResult(io.stat!(p));
      },
      fsExists: (p) => {
        const io = ensureIO("fsExists");
        if (!io.exists) fail("fsExists", "not supported by this host");
        return fromHostResult(io.exists!(p));
      },
      fsDelete: (p) => {
        const io = ensureIO("fsDelete");
        if (!io.deleteFile) fail("fsDelete", "not supported by this host");
        return fromHostResult(io.deleteFile!(p));
      },
      // Host: events
      emitEvent: (payload = null) => fromHost(ensureEvents("emitEvent").emit(toHost(payload)) ?? null),
      pollEvent: () => fromHost(ensureEvents("pollEvent").poll() ?? null),
      // Host: PulsarOS IPC
      ipcSetContext: (deviceId, processId) => {
        this.ipcDefaults.deviceId = deviceId;
        this.ipcDefaults.processId = processId;
        return null;
      },
      ipcSend: (channel, op, payload) => handleIPCResponse("ipcSend", ensureIPC("ipcSend").send(normalizeEnvelope("ipcSend", channel, op, payload))),
    };

    // The registry is the contract: every entry needs an implementation and nothing else is
    // exposed, so the interpreter cannot drift from the compiler and the VM (D5).
    for (const name of Object.keys(impls)) {
      if (!lookupHostFunction(name)) throw new Error(`Interpreter implements '${name}', which is not in hostapi.json`);
    }
    for (const fn of HOST_FUNCTIONS) {
      const impl = impls[fn.name];
      if (!impl) throw new Error(`hostapi.json entry '${fn.name}' has no interpreter implementation`);
      const { min, max } = arityRange(fn);
      const native: PulsarCallable = {
        arity: () => (min === max ? min : -1),
        call: (_: Interpreter, args: any[]) => {
          const arity = arityError(fn, args.length);
          if (arity) throw this.createRuntimeError(nativeToken(fn.name), arity);
          if (this.options.strictTypes) this.checkArgTypes(fn, args, nativeToken(fn.name));
          return impl(...args);
        },
        toString: () => `<native ${fn.name}>`,
      };
      this.globals.define(fn.name, native);
    }
  }

  /** Argument kinds from hostapi.json, as the Go VM checks them. */
  private checkArgTypes(fn: HostFunction, args: any[], token: Token): void {
    args.forEach((arg, i) => {
      const param = fn.params[Math.min(i, fn.params.length - 1)];
      if (!param || param.type === "any") return;
      const kind = KIND_OF(arg);
      if (!param.type.split("|").includes(kind)) {
        throw this.createRuntimeError(token, `${fn.name}: argument ${i + 1} (${param.name}) must be ${param.type.replace(/\|/g, " or ")}, got ${kind}`);
      }
    });
  }

  /** Names registered with registerHandler, for embedders (SPEC §9). */
  handlerNames(): string[] {
    return [...this.handlers.keys()];
  }

  /** Invokes a registered handler with fresh budgets; throws RuntimeError or BudgetError. */
  callHandler(name: string, args: any[] = []): any {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error(`handler not found: ${name}`);
    if (fn.arity() !== args.length) throw new Error(`handler ${name} expects ${fn.arity()} args, got ${args.length}`);
    this.resetBudget();
    return fn.call(this, args.map(fromHost));
  }

  private resetBudget(): void {
    this.steps = 0;
    this.deadline = this.limits.timeoutMs > 0 && Number.isFinite(this.limits.timeoutMs) ? Date.now() + this.limits.timeoutMs : Infinity;
  }

  /** Counts one step and enforces the step and time budgets (D10). */
  private tick(): void {
    this.steps++;
    const max = this.limits.maxSteps;
    if (max > 0 && this.steps > max) throw new BudgetError("step budget exceeded");
    if ((this.steps & 1023) === 0 && Date.now() > this.deadline) throw new BudgetError("time budget exceeded");
  }

  /** Called on every user-function call; recursion past maxCallDepth is a catchable runtime error. */
  enterCall(token: Token, frame: CallFrame): void {
    const max = this.limits.maxCallDepth;
    if (max > 0 && this.callStack.length >= max) {
      throw this.createRuntimeError(token, `Stack overflow (more than ${max} nested calls).`);
    }
    this.tick();
    this.callStack.push(frame);
  }

  interpret(statements: Stmt[]): void {
    this.resetBudget();
    try {
      // Hoist top-level functions so they can be called before their declaration (SPEC 4.6, D2).
      for (const statement of statements) {
        if (statement instanceof FunctionStmt) this.execute(statement);
      }
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
      this.tick();
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
        this.tick();
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
    // && and || short-circuit and always produce a boolean (SPEC 4.4, D16).
    if (expr.operator.type === TokenType.AND) {
      return this.isTruthy(this.evaluate(expr.left)) && this.isTruthy(this.evaluate(expr.right));
    }
    if (expr.operator.type === TokenType.OR) {
      return this.isTruthy(this.evaluate(expr.left)) || this.isTruthy(this.evaluate(expr.right));
    }

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
        // Adds two numbers; concatenates printed forms when either side is a string (SPEC §4.2, D6).
        if (typeof left === 'number' && typeof right === 'number') {
          return left + right;
        }
        if (typeof left === 'string' || typeof right === 'string') {
          return this.stringify(left) + this.stringify(right);
        }
        throw this.createRuntimeError(expr.operator, "Operands must be two numbers, or include a string.");
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

    try {
      return func.call(this, args);
    } catch (err) {
      // Built-ins raise errors without a source position; report them at the call.
      if (err instanceof RuntimeError && !(err.token?.line > 0)) {
        throw new RuntimeError(expr.paren, err.message, err.callStack);
      }
      throw err;
    }
  }

  visitArrayExpr(expr: ArrayExpr): any {
    return expr.elements.map((e) => this.evaluate(e));
  }

  visitObjectExpr(expr: ObjectExpr): any {
    const obj = new Map<string, any>();
    for (const prop of expr.properties) {
      obj.set(prop.key, this.evaluate(prop.value));
    }
    return obj;
  }

  visitTryCatchStmt(stmt: TryCatchStmt): void {
    try {
      this.executeBlock(stmt.tryBlock, new Environment(this.environment));
    } catch (err) {
      // `return` inside try is not an error (D19), and budgets cannot be caught (D10).
      if (err instanceof ReturnException || err instanceof BudgetError) throw err;
      const env = new Environment(this.environment);
      if (stmt.catchParam) {
        env.define(stmt.catchParam, this.errorToValue(err));
      }
      this.executeBlock(stmt.catchBlock, env);
    }
  }

  visitErrorExpr(expr: ErrorExpr): any {
    return { message: expr.message, metadata: expr.metadata ?? null };
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

  popCallFrame(): void {
    this.callStack.pop();
  }

  createRuntimeError(token: Token, message: string): RuntimeError {
    return new RuntimeError(token, message, [...this.callStack]);
  }

  private execute(stmt: Stmt): void {
    this.tick();
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
    return valuesEqual(a, b);
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
    return stringify(value, (v) => (this.isCallable(v) ? (v as PulsarCallable).toString() : String(v)));
  }

  private generateNonce(): string {
    const maybeCrypto: any = (globalThis as any).crypto;
    if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
      return maybeCrypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * The value bound by catch (SPEC §7, D7): an object {kind: "runtime", line, message}.
   * `line` is nil when the position is unknown.
   */
  private errorToValue(err: any): Map<string, any> {
    let line: number | null = null;
    let message: string;
    if (err instanceof RuntimeError) {
      message = err.message;
      line = err.token?.line > 0 ? err.token.line : null;
    } else if (err instanceof RangeError) {
      message = "Stack overflow.";
    } else if (err instanceof Error) {
      message = err.message;
    } else {
      message = this.stringify(err);
    }
    return new Map<string, any>([["kind", "runtime"], ["line", line], ["message", message]]);
  }
}

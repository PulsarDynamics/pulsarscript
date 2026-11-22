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

const RE_INTEGER_BASE10 = /^[+-]?\d+$/;
const RE_INTEGER_OTHER = /^[+-]?[0-9a-z]+$/i;
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
export type InterpreterOptions = {
  strictTypes?: boolean;
  ipc?: IPCBridge;
  defaultDeviceId?: string;
  defaultProcessId?: string;
  modules?: Record<string, any>;
  moduleLoader?: (name: string) => any;
  io?: IOBridge;
};

export class Interpreter implements ExprVisitor<any>, StmtVisitor<void> {
  private globals: Environment;
  private environment: Environment;
  // strictTypes defaults to true: arithmetic on non-numbers is a runtime error, as on the VM
  // (SPEC §4.2). strictTypes: false restores the old coercing behaviour for built-in arguments.
  private options: InterpreterOptions & { strictTypes: boolean; modules: Record<string, any> } = {
    strictTypes: true,
    ipc: undefined,
    defaultDeviceId: undefined,
    defaultProcessId: undefined,
    modules: {},
    moduleLoader: undefined,
    io: undefined,
  };
  private callStack: CallFrame[] = [];
  private ipcBridge?: IPCBridge;
  private ipcDefaults: { deviceId?: string; processId?: string } = {};
  private moduleCache: Map<string, any> = new Map();

  constructor(options?: InterpreterOptions) {
    // Initialize globals with reference to this interpreter
    this.globals = new Environment(null, this);
    this.environment = this.globals;
    if (options) {
      this.options = {
        strictTypes: options.strictTypes ?? true,
        ipc: options.ipc,
        defaultDeviceId: options.defaultDeviceId,
        defaultProcessId: options.defaultProcessId,
        modules: options.modules ?? {},
        moduleLoader: options.moduleLoader,
        io: options.io,
      };
    }
    this.ipcBridge = this.options.ipc;
    this.ipcDefaults.deviceId = this.options.defaultDeviceId ?? this.ipcBridge?.defaultDeviceId;
    this.ipcDefaults.processId = this.options.defaultProcessId ?? this.ipcBridge?.defaultProcessId;
    // Preload provided modules
    Object.entries(this.options.modules).forEach(([k, v]) => this.moduleCache.set(k, v));
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
    const loadModule = (name: any): any => {
      const key = requireString("importModule", name);
      if (this.moduleCache.has(key)) {
        return this.moduleCache.get(key);
      }
      if (this.options.moduleLoader) {
        const mod = this.options.moduleLoader(key);
        this.moduleCache.set(key, mod);
        return mod;
      }
      if (Object.prototype.hasOwnProperty.call(this.options.modules, key)) {
        const mod = (this.options.modules as any)[key];
        this.moduleCache.set(key, mod);
        return mod;
      }
      throw this.createRuntimeError(mkNativeToken("importModule"), `module '${key}' not found`);
    };
    const ensureIO = () => {
      if (!this.options.io) throw this.createRuntimeError(mkNativeToken("io"), "IO bridge not configured");
      return this.options.io;
    };
    // Host results become language values; async results stay promises (resolved by the host).
    const wrapPromise = (val: any) => (val instanceof Promise ? val.then(fromHost) : fromHost(val));
    const ensureIPC = () => {
      if (!this.ipcBridge) throw this.createRuntimeError(mkNativeToken("ipc"), "IPC bridge not configured");
      return this.ipcBridge;
    };
    const ensureCallableValue = (name: string, v: any): PulsarCallable => {
      if (this.isCallable(v)) return v as PulsarCallable;
      throw this.createRuntimeError(mkNativeToken(name), `${name}: expected function`);
    };
    const normalizeEnvelope = (token: string, channel: any, op: any, payload: any, deviceId?: any, processId?: any, nonce?: any, ts?: any): IPCEnvelope => {
      const bridge = ensureIPC();
      const dev = deviceId ?? this.ipcDefaults.deviceId ?? bridge.defaultDeviceId;
      const proc = processId ?? this.ipcDefaults.processId ?? bridge.defaultProcessId;
      if (!dev) throw this.createRuntimeError(mkNativeToken(token), `${token}: deviceId is required`);
      if (!proc) throw this.createRuntimeError(mkNativeToken(token), `${token}: processId is required`);
      const envelope: IPCEnvelope = {
        v: 1,
        deviceId: String(dev),
        processId: String(proc),
        channel: String(channel),
        op: String(op),
        payload: toHost(payload),
        nonce: typeof nonce === "string" && nonce.length > 0 ? nonce : this.generateNonce(),
        ts: Number.isFinite(ts) ? Number(ts) : Date.now(),
      };
      return envelope;
    };
    const handleIPCResponse = (resp: IPCResponse | void, token: string) => {
      if (!resp) return null;
      if (resp.error) {
        const msg = resp.error.message ? `${resp.error.code}: ${resp.error.message}` : resp.error.code;
        throw this.createRuntimeError(mkNativeToken(token), msg);
      }
      return fromHost(resp.result ?? null);
    };

    // Core / Types
    defineNative("typeOf", 1, (v) => typeName(v));

    // Conversions
    defineNative("number", 1, (v) => toNumber(v));
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
    // Length of a string in Unicode code points, or of an array (SPEC §8).
    defineNative("len", 1, (s) => {
      if (isArray(s)) return s.length;
      if (typeof s === "string") return [...s].length;
      if (this.options.strictTypes) throw this.createRuntimeError(mkNativeToken("len"), "len: expected string or array");
      return [...String(s)].length;
    });
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

    // Variadic concatenation of the printed forms of all arguments (same on the VM).
    defineNative("concat", -1, (...args) => args.map((a) => this.stringify(a)).join(""));

    // Arrays and objects (SPEC §3.3, §8). They are values: every function returns a new array
    // or object and never changes its arguments. Mirrors the Go VM's implementations.
    const requireArray = (name: string, v: any): any[] => {
      if (isArray(v)) return v;
      throw this.createRuntimeError(mkNativeToken(name), `${name}: expected array`);
    };
    const requireObject = (name: string, v: any): Map<string, any> => {
      if (isObject(v)) return v;
      throw this.createRuntimeError(mkNativeToken(name), `${name}: expected object`);
    };
    const requireIndex = (name: string, v: any): number => {
      if (typeof v !== "number") throw this.createRuntimeError(mkNativeToken(name), `${name}: start and end must be numbers`);
      return Math.trunc(v);
    };
    const key = (k: any): string => this.stringify(k);
    defineNative("arrayLen", 1, (a) => requireArray("arrayLen", a).length);
    defineNative("arrayPush", -1, (a, ...values) => {
      if (values.length === 0) throw this.createRuntimeError(mkNativeToken("arrayPush"), "arrayPush: expected an array and at least one value");
      return [...requireArray("arrayPush", a), ...values];
    });
    defineNative("arrayPop", 1, (a) => {
      const arr = requireArray("arrayPop", a);
      return arr.length === 0 ? null : arr[arr.length - 1];
    });
    defineNative("arraySlice", 3, (a, start, end) => {
      const arr = requireArray("arraySlice", a);
      const lo = Math.max(0, requireIndex("arraySlice", start));
      const hi = Math.min(arr.length, requireIndex("arraySlice", end));
      return lo > hi ? [] : arr.slice(lo, hi);
    });
    defineNative("arrayConcat", -1, (...arrays) => {
      if (arrays.length < 2) throw this.createRuntimeError(mkNativeToken("arrayConcat"), "arrayConcat: expected at least 2 arrays");
      return arrays.flatMap((a) => requireArray("arrayConcat", a));
    });
    defineNative("arrayIndexOf", 2, (a, v) => requireArray("arrayIndexOf", a).findIndex((x) => valuesEqual(x, v)));
    defineNative("objKeys", 1, (o) => sortedKeys(requireObject("objKeys", o)));
    defineNative("objValues", 1, (o) => {
      const obj = requireObject("objValues", o);
      return sortedKeys(obj).map((k) => obj.get(k));
    });
    defineNative("objHas", 2, (o, k) => requireObject("objHas", o).has(key(k)));
    defineNative("objGet", 2, (o, k) => requireObject("objGet", o).get(key(k)) ?? null);
    defineNative("objSet", 3, (o, k, v) => new Map(requireObject("objSet", o)).set(key(k), v));

    // Safe parsing utilities
    defineNative("parseInt", 2, (s, base) => {
      if (typeof s === 'number') return Number.isInteger(s) ? s : null;
      const b = requireNumber("parseInt", base);
      if (!(b >= 2 && b <= 36)) return null;
      const str = requireString("parseInt", s).trim();
      const regex = b === 10 ? RE_INTEGER_BASE10 : RE_INTEGER_OTHER;
      if (!regex.test(str)) return null;
      const n = parseInt(str, b);
      return Number.isNaN(n) ? null : n;
    });
    defineNative("parseFloat", 1, (s) => {
      if (typeof s === 'number') return s;
      const str = requireString("parseFloat", s).trim();
      // Strict float: no trailing junk
      if (!RE_FLOAT.test(str)) return null;
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

    // IPC helpers
    defineNative("ipcNonce", 0, () => this.generateNonce());
    defineNative("ipcSetContext", 2, (deviceId, processId) => {
      if (deviceId !== null && deviceId !== undefined) {
        this.ipcDefaults.deviceId = requireString("ipcSetContext", deviceId);
      }
      if (processId !== null && processId !== undefined) {
        this.ipcDefaults.processId = requireString("ipcSetContext", processId);
      }
      return null;
    });
    defineNative("ipcEnvelope", -1, (channel, op, payload, deviceId?, processId?, nonce?, ts?) => {
      return fromHost(normalizeEnvelope("ipcEnvelope", channel, op, payload, deviceId, processId, nonce, ts));
    });
    defineNative("ipcSend", -1, (channel, op, payload, deviceId?, processId?, nonce?, ts?) => {
      const env = normalizeEnvelope("ipcSend", channel, op, payload, deviceId, processId, nonce, ts);
      const resp = ensureIPC().send(env);
      return handleIPCResponse(resp, "ipcSend");
    });
    defineNative("ipcSendRaw", 1, (raw) => {
      if (raw === null || typeof raw !== "object" || isArray(raw)) {
        throw this.createRuntimeError(mkNativeToken("ipcSendRaw"), "ipcSendRaw: envelope object required");
      }
      const envObj = toHost(raw) as Partial<IPCEnvelope>;
      if (!envObj.channel || !envObj.op) {
        throw this.createRuntimeError(mkNativeToken("ipcSendRaw"), "ipcSendRaw: channel and op are required");
      }
      const env = normalizeEnvelope("ipcSendRaw", envObj.channel, envObj.op, envObj.payload, envObj.deviceId, envObj.processId, envObj.nonce, envObj.ts);
      env.v = envObj.v ?? env.v;
      const resp = ensureIPC().send(env);
      return handleIPCResponse(resp, "ipcSendRaw");
    });
    defineNative("ipcSendAsync", -1, (channel, op, payload, onResult?, onError?, deviceId?, processId?, nonce?, ts?) => {
      const env = normalizeEnvelope("ipcSendAsync", channel, op, payload, deviceId, processId, nonce, ts);
      const bridge = ensureIPC();
      const resultCb = onResult !== undefined && onResult !== null ? ensureCallableValue("ipcSendAsync", onResult) : null;
      const errorCb = onError !== undefined && onError !== null ? ensureCallableValue("ipcSendAsync", onError) : null;
      const handle = (resp: IPCResponse | void) => {
        if (resp && resp.error && errorCb) {
          errorCb.call(this, [fromHost(resp.error)]);
          return;
        }
        const val = resp ? fromHost(resp.result ?? null) : null;
        if (resultCb) {
          resultCb.call(this, [val]);
        }
      };
      const handleErr = (err: any) => {
        if (errorCb) {
          const errVal = this.errorToValue(err);
          errorCb.call(this, [errVal]);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          throw this.createRuntimeError(mkNativeToken("ipcSendAsync"), msg);
        }
      };
      if (typeof bridge.sendAsync === "function") {
        bridge.sendAsync(env).then(handle).catch(handleErr);
      } else {
        try {
          const resp = bridge.send(env);
          handle(resp);
        } catch (err) {
          handleErr(err);
        }
      }
      return null;
    });

    // Error handling helpers
    defineNative("tryCatch", 2, (fn, handler) => {
      const f = ensureCallableValue("tryCatch", fn);
      const h = ensureCallableValue("tryCatch", handler);
      try {
        return f.call(this, []);
      } catch (err) {
        const errVal = this.errorToValue(err);
        return h.call(this, [errVal]);
      }
    });

    // Module system
    defineNative("importModule", 1, (name) => loadModule(name));
    defineNative("registerModule", 2, (name, exports) => {
      const key = requireString("registerModule", name);
      this.moduleCache.set(key, exports);
      return null;
    });

    // Sandboxed IO (host provided)
    defineNative("fsRead", 1, (path) => {
      const io = ensureIO();
      const p = requireString("fsRead", path);
      return wrapPromise(io.readFile(p));
    });
    defineNative("fsWrite", 2, (path, data) => {
      const io = ensureIO();
      const p = requireString("fsWrite", path);
      const payload = data === null || data === undefined ? "" : this.stringify(data);
      return wrapPromise(io.writeFile(p, payload));
    });
    defineNative("fsList", 1, (path) => {
      const io = ensureIO();
      const p = requireString("fsList", path);
      return wrapPromise(io.listDir(p));
    });
    defineNative("kvGet", 1, (key) => {
      const io = ensureIO();
      if (!io.kvGet) throw this.createRuntimeError(mkNativeToken("kvGet"), "kv storage not available");
      const k = requireString("kvGet", key);
      return wrapPromise(io.kvGet(k));
    });
    defineNative("kvSet", 2, (key, value) => {
      const io = ensureIO();
      if (!io.kvSet) throw this.createRuntimeError(mkNativeToken("kvSet"), "kv storage not available");
      const k = requireString("kvSet", key);
      return wrapPromise(io.kvSet(k, toHost(value)));
    });
    defineNative("kvDelete", 1, (key) => {
      const io = ensureIO();
      if (!io.kvDelete) throw this.createRuntimeError(mkNativeToken("kvDelete"), "kv storage not available");
      const k = requireString("kvDelete", key);
      return wrapPromise(io.kvDelete(k));
    });
  }

  interpret(statements: Stmt[]): void {
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
      // `return` inside try is not an error (D19).
      if (err instanceof ReturnException) throw err;
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

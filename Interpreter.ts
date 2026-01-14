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
import type { IPCBridge, IPCEnvelope, IPCResponse } from "./interfaces/IPC";
import type { IOBridge } from "./interfaces/IO";
import { ErrorExpr } from "./classes/ErrorExpr";
import { TryCatchStmt } from "./classes/TryCatchStmt";
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
type InterpreterOptions = {
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
  private options: Required<InterpreterOptions> = {
    strictTypes: false,
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
        strictTypes: options.strictTypes ?? false,
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
    const wrapPromise = async (val: any) => (val instanceof Promise ? await val : val);
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
        payload,
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
      return resp.result ?? null;
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
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (typeof a === 'string') continue;
            if (typeof a === 'number') {
              args[i] = this.stringify(a);
              continue;
            }
            throw this.createRuntimeError(concatToken, "concat: arguments must be string or number in strict mode");
          }
          return args.join("");
        }
        // Non-strict: stringify everything.
        for (let i = 0; i < args.length; i++) {
          args[i] = this.stringify(args[i]);
        }
        return args.join("");
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
      return normalizeEnvelope("ipcEnvelope", channel, op, payload, deviceId, processId, nonce, ts);
    });
    defineNative("ipcSend", -1, (channel, op, payload, deviceId?, processId?, nonce?, ts?) => {
      const env = normalizeEnvelope("ipcSend", channel, op, payload, deviceId, processId, nonce, ts);
      const resp = ensureIPC().send(env);
      return handleIPCResponse(resp, "ipcSend");
    });
    defineNative("ipcSendRaw", 1, (raw) => {
      if (raw === null || typeof raw !== "object") {
        throw this.createRuntimeError(mkNativeToken("ipcSendRaw"), "ipcSendRaw: envelope object required");
      }
      const envObj = raw as Partial<IPCEnvelope>;
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
          errorCb.call(this, [resp.error]);
          return;
        }
        const val = resp ? resp.result ?? null : null;
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
      return wrapPromise(io.kvSet(k, value));
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
            return (left as number) + (right as number);
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

    const result = func.call(this, args);
    // Allow async returns from host bridges (fs/kv/ipc sendAsync callbacks)
    return result instanceof Promise ? result : result;
  }

  visitTryCatchStmt(stmt: TryCatchStmt): void {
    try {
      this.executeBlock(stmt.tryBlock, new Environment(this.environment));
    } catch (err) {
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

  private generateNonce(): string {
    const maybeCrypto: any = (globalThis as any).crypto;
    if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
      return maybeCrypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private errorToValue(err: any): any {
    if (err instanceof RuntimeError) {
      return {
        message: err.message,
        line: err.token?.line ?? null,
        lexeme: err.token?.lexeme ?? null,
        callStack: err.callStack ?? null,
      };
    }
    if (err instanceof Error) {
      return { message: err.message, name: err.name };
    }
    return { message: this.stringify(err) };
  }
}

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
import { compareStringsByCodePoint, fromHost, isArray, isObject, sortedKeys, stringify, toHost, toNumber, typeName, valuesEqual } from "./Values";
import { HOST_FUNCTIONS, arityError, arityRange, lookupHostFunction, type HostFunction } from "./HostApi";
import { IndexExpr } from "./classes/IndexExpr";
import type { SetIndex } from "./classes/SetIndex";
import type { BreakStmt } from "./classes/BreakStmt";
import type { ForOfStmt } from "./classes/ForOfStmt";
import type { TernaryExpr } from "./classes/TernaryExpr";
import type { TemplateLiteralExpr } from "./classes/TemplateLiteralExpr";
import { FunctionExpr } from "./classes/FunctionExpr";
import type { ImportStmt } from "./classes/ImportStmt";
import { ExportStmt } from "./classes/ExportStmt";

const RE_FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

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

/**
 * Uncatchable memory limit error (LANG-01): string/collection/live-heap bounds.
 */
export class MemoryLimitError extends RuntimeError {
  constructor(token: Token, message: string, callStack: CallFrame[] = []) {
    const msg = message.startsWith("memory limit exceeded:") ? message : `memory limit exceeded: ${message}`;
    super(token, msg, callStack);
  }
}

// Return exception for function returns. It is control flow, not an error: try/catch must
// never catch it (D19).
/** `break` or `continue`, unwinding to the nearest loop. Not an error: try/catch lets it pass. */
class LoopSignal extends Error {
  isContinue: boolean;

  constructor(isContinue: boolean) {
    super();
    this.isContinue = isContinue;
  }
}

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
  call(interpreter: Interpreter, args: any[], callLine?: number): any;
  toString(): string;
}

// Function wrapper (both declared FunctionStmt and closure FunctionExpr)
class PulsarFunction implements PulsarCallable {
  private declaration: FunctionStmt | FunctionExpr;
  private closure: Environment;

  constructor(declaration: FunctionStmt | FunctionExpr, closure: Environment) {
    this.declaration = declaration;
    this.closure = closure;
  }

  get functionName(): string {
    return this.declaration.name?.lexeme ?? "";
  }

  arity(): number {
    return this.declaration.params.length;
  }

  call(interpreter: Interpreter, args: any[], callLine = 0): any {
    const environment = new Environment(this.closure);
    if (this.declaration instanceof FunctionExpr && this.declaration.name) {
      const selfName = this.declaration.name.lexeme;
      if (!this.declaration.params.some((p) => p.lexeme === selfName)) {
        environment.define(selfName, this);
      }
    }

    const tok = this.declaration instanceof FunctionExpr
      ? (this.declaration.name ?? this.declaration.keyword)
      : this.declaration.name;
    interpreter.enterCall(tok, {
      functionName: this.functionName || "<anonymous>",
      line: tok.line,
      callLine,
      callFile: interpreter.currentSourceFile(),
    });
    const prevFile = interpreter.enterFile((this.declaration as any).sourceIndex);

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
      interpreter.exitFile(prevFile);
      interpreter.popCallFrame();
    }
  }

  toString(): string {
    return `<fn ${this.functionName || "anonymous"}>`;
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
  maxStringBytes?: number;
  maxCollectionLen?: number;
  maxMemoryBytes?: number;
}

export const DEFAULT_LIMITS: Required<ExecutionLimits> = {
  maxSteps: 10_000_000,
  timeoutMs: 10_000,
  maxCallDepth: 256,
  maxStringBytes: 16 * 1024 * 1024,
  maxCollectionLen: 1_000_000,
  maxMemoryBytes: 256 * 1024 * 1024,
};

/** Bridge for emitEvent/pollEvent (host provided). */
export interface EventBridge {
  emit(payload: unknown): unknown;
  poll(): unknown;
  /** Delivers a payload to the app's open windows (notifyWindow). */
  notifyWindow?(payload: unknown): unknown;
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
  private memBytes = 0;
  private callStack: CallFrame[] = [];
  private ipcBridge?: IPCBridge;
  private ipcDefaults: { deviceId?: string; processId?: string } = {};
  private handlers: Map<string, PulsarFunction> = new Map();
  private eventListeners: Map<string, PulsarFunction[]> = new Map();
  private rngState: number | null = null;
  private textEncoder = new TextEncoder();
  private currentCallLine = 0;
  private sources: string[] = [];
  private currentFileIndex = 0;

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
    const fromHostResult = (val: any) => (val instanceof Promise ? val.then((v) => this.accountValue(fromHost(v))) : this.accountValue(fromHost(val)));
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
    const callCallback = (fnName: string, cb: any, cbArgs: any[]): any => {
      if (!this.isCallable(cb)) fail(fnName, `expected function, got ${typeName(cb)}`);
      const f = cb as PulsarCallable;
      const expected = f.arity();
      if (expected >= 0 && cbArgs.length !== expected) {
        const cbName = cb instanceof PulsarFunction && cb.functionName ? cb.functionName : "callback";
        fail(fnName, `${cbName} expects ${expected} args, got ${cbArgs.length}`);
      }
      return f.call(this, cbArgs, this.currentCallLine);
    };
    const mergeSort = (items: any[], less: (a: any, b: any) => boolean): any[] => {
      if (items.length <= 1) return [...items];
      const mid = Math.floor(items.length / 2);
      const left = mergeSort(items.slice(0, mid), less);
      const right = mergeSort(items.slice(mid), less);
      const out: any[] = [];
      let i = 0;
      let j = 0;
      while (i < left.length && j < right.length) {
        if (less(right[j], left[i])) {
          out.push(right[j++]);
        } else {
          out.push(left[i++]);
        }
      }
      while (i < left.length) out.push(left[i++]);
      while (j < right.length) out.push(right[j++]);
      return out;
    };
    const padStr = (fnName: string, sVal: any, lenVal: any, fillVal: any, padStartMode: boolean): string => {
      const s = str(fnName, sVal);
      const targetNum = num(fnName, lenVal);
      if (!Number.isFinite(targetNum)) fail(fnName, "length must be a finite number");
      const targetLen = Math.trunc(targetNum);
      const fill = fillVal === undefined ? " " : str(fnName, fillVal);
      const sChars = codePoints(s);
      if (targetLen <= sChars.length || fill === "") return s;
      const fillChars = codePoints(fill);
      const need = targetLen - sChars.length;
      const fullCopies = Math.floor(need / fillChars.length);
      const rem = need % fillChars.length;
      const sBytes = this.utf8ByteLength(s);
      const fillBytes = this.utf8ByteLength(fill);
      let remBytes = 0;
      for (let i = 0; i < rem; i++) remBytes += this.utf8ByteLength(fillChars[i]);
      this.checkStringSize(sBytes + fullCopies * fillBytes + remBytes, nativeToken(fnName));
      const pad = fill.repeat(fullCopies) + fillChars.slice(0, rem).join("");
      return padStartMode ? pad + s : s + pad;
    };
    const convertParsedJSON = (val: any, depth: number): any => {
      if (val === null || typeof val === "boolean") return val;
      if (typeof val === "number") {
        if (!Number.isFinite(val)) fail("jsonParse", "non-finite number");
        return val === 0 ? 0 : val;
      }
      if (typeof val === "string") {
        this.checkStringSize(this.utf8ByteLength(val), nativeToken("jsonParse"));
        return val;
      }
      if (depth + 1 > 64) fail("jsonParse", "maximum nesting depth 64 exceeded");
      if (Array.isArray(val)) {
        this.checkCollectionSize(val.length, nativeToken("jsonParse"));
        this.accountAlloc(48 + val.length * 32, nativeToken("jsonParse"));
        return val.map((el) => convertParsedJSON(el, depth + 1));
      }
      if (typeof val === "object") {
        const entries = Object.entries(val);
        this.checkCollectionSize(entries.length, nativeToken("jsonParse"));
        this.accountAlloc(48 + entries.length * 48, nativeToken("jsonParse"));
        const m = new Map<string, any>();
        for (const [k, v] of entries) {
          this.checkStringSize(this.utf8ByteLength(k), nativeToken("jsonParse"));
          m.set(k, convertParsedJSON(v, depth + 1));
        }
        return m;
      }
      return fail("jsonParse", "unsupported value");
    };
    const serializeJSON = (val: any, depth: number): string => {
      if (val === null || val === undefined) return "null";
      if (typeof val === "boolean") return val ? "true" : "false";
      if (typeof val === "number") {
        if (!Number.isFinite(val)) return fail("jsonStringify", "cannot serialize non-finite number");
        return JSON.stringify(val === 0 ? 0 : val);
      }
      if (typeof val === "string") return JSON.stringify(val);
      if (isArray(val)) {
        if (depth + 1 > 64) return fail("jsonStringify", "maximum nesting depth 64 exceeded");
        return "[" + val.map((el) => serializeJSON(el, depth + 1)).join(",") + "]";
      }
      if (isObject(val)) {
        if (depth + 1 > 64) return fail("jsonStringify", "maximum nesting depth 64 exceeded");
        const keys = sortedKeys(val);
        return "{" + keys.map((k) => `${JSON.stringify(k)}:${serializeJSON(val.get(k), depth + 1)}`).join(",") + "}";
      }
      if (this.isCallable(val)) return fail("jsonStringify", "cannot serialize function");
      return fail("jsonStringify", "unsupported value kind");
    };
    const RE_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/;
    const daysInMonthUTC = (year: number, month: number): number => {
      if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
      if ([4, 6, 9, 11].includes(month)) return 30;
      return 31;
    };

    // One implementation per hostapi.json entry (SPEC §8). Arity and argument types are checked
    // from the registry before an implementation runs (see defineRegistered below).
    const impls: Record<string, (...args: any[]) => any> = {
      // Core / types
      typeOf: (v) => typeName(v),
      string: (v) => {
        if (typeof v === "string") return v;
        const s = this.stringify(v);
        this.checkStringSize(this.utf8ByteLength(s), nativeToken("string"));
        return s;
      },
      number: (v) => toNumber(v),
      concat: (...args) => {
        const parts = args.map((a) => this.stringify(a));
        let bytes = 0;
        for (const p of parts) bytes += this.utf8ByteLength(p);
        this.checkStringSize(bytes, nativeToken("concat"));
        return parts.join("");
      },
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
      sin: (n) => Math.sin(num("sin", n)),
      cos: (n) => Math.cos(num("cos", n)),
      tan: (n) => Math.tan(num("tan", n)),
      atan2: (y, x) => Math.atan2(num("atan2", y), num("atan2", x)),
      log: (n) => Math.log(num("log", n)),
      log10: (n) => Math.log10(num("log10", n)),
      exp: (n) => Math.exp(num("exp", n)),
      mathPi: () => Math.PI,
      mathE: () => Math.E,
      // Strings (indices and lengths count code points, like len)
      toUpper: (s) => {
        const res = str("toUpper", s).toUpperCase();
        this.checkStringSize(this.utf8ByteLength(res), nativeToken("toUpper"));
        return res;
      },
      toLower: (s) => {
        const res = str("toLower", s).toLowerCase();
        this.checkStringSize(this.utf8ByteLength(res), nativeToken("toLower"));
        return res;
      },
      trim: (s) => str("trim", s).trim(),
      indexOf: (s, sub, start) => {
        const chars = codePoints(str("indexOf", s));
        const subChars = codePoints(str("indexOf", sub));
        let startIdx = 0;
        if (start !== undefined) {
          const sn = num("indexOf", start);
          if (!Number.isFinite(sn)) fail("indexOf", "start index must be a finite number");
          startIdx = Math.max(0, Math.trunc(sn));
        }
        if (startIdx > chars.length) return -1;
        if (subChars.length === 0) return startIdx;
        const limit = chars.length - subChars.length;
        for (let i = startIdx; i <= limit; i++) {
          let match = true;
          for (let j = 0; j < subChars.length; j++) {
            if (chars[i + j] !== subChars[j]) {
              match = false;
              break;
            }
          }
          if (match) return i;
        }
        return -1;
      },
      lastIndexOf: (s, sub, start) => {
        const chars = codePoints(str("lastIndexOf", s));
        const subChars = codePoints(str("lastIndexOf", sub));
        let maxIdx = chars.length;
        if (start !== undefined) {
          const sn = num("lastIndexOf", start);
          if (!Number.isFinite(sn)) fail("lastIndexOf", "start index must be a finite number");
          maxIdx = Math.min(chars.length, Math.max(0, Math.trunc(sn)));
        }
        if (subChars.length === 0) return maxIdx;
        const limit = chars.length - subChars.length;
        for (let i = Math.min(maxIdx, limit); i >= 0; i--) {
          let match = true;
          for (let j = 0; j < subChars.length; j++) {
            if (chars[i + j] !== subChars[j]) {
              match = false;
              break;
            }
          }
          if (match) return i;
        }
        return -1;
      },
      split: (s, sep) => {
        const text = str("split", s);
        const delim = str("split", sep);
        const parts = delim === "" ? codePoints(text) : text.split(delim);
        this.checkCollectionSize(parts.length, nativeToken("split"));
        this.accountAlloc(48 + parts.length * 32, nativeToken("split"));
        return parts;
      },
      replace: (s, target, replacement) => {
        const text = str("replace", s);
        const tgt = str("replace", target);
        const repl = str("replace", replacement);
        const textBytes = this.utf8ByteLength(text);
        const replBytes = this.utf8ByteLength(repl);
        if (tgt === "") {
          const chars = codePoints(text);
          if (replBytes > 0) {
            this.checkStringSize(textBytes + (chars.length + 1) * replBytes, nativeToken("replace"));
          }
          const res = chars.length === 0 ? repl : repl + chars.map((c) => c + repl).join("");
          this.checkStringSize(this.utf8ByteLength(res), nativeToken("replace"));
          return res;
        }
        const parts = text.split(tgt);
        const count = parts.length - 1;
        if (count > 0 && replBytes > this.utf8ByteLength(tgt)) {
          this.checkStringSize(textBytes + count * (replBytes - this.utf8ByteLength(tgt)), nativeToken("replace"));
        }
        const res = parts.join(repl);
        this.checkStringSize(this.utf8ByteLength(res), nativeToken("replace"));
        return res;
      },
      startsWith: (s, prefix) => str("startsWith", s).startsWith(str("startsWith", prefix)),
      endsWith: (s, suffix) => str("endsWith", s).endsWith(str("endsWith", suffix)),
      repeat: (s, count) => {
        const text = str("repeat", s);
        const cnt = num("repeat", count);
        if (!Number.isFinite(cnt) || cnt < 0) fail("repeat", "count must be a finite non-negative number");
        const n = Math.trunc(cnt);
        if (n === 0 || text === "") return "";
        const byteLen = this.utf8ByteLength(text);
        const maxStr = this.limits.maxStringBytes;
        if (maxStr > 0 && Number.isFinite(maxStr) && n > Math.floor(maxStr / byteLen)) {
          this.checkStringSize(maxStr + 1, nativeToken("repeat"));
        }
        this.checkStringSize(byteLen * n, nativeToken("repeat"));
        return text.repeat(n);
      },
      padStart: (s, length, fill) => padStr("padStart", s, length, fill, true),
      padEnd: (s, length, fill) => padStr("padEnd", s, length, fill, false),
      charCodeAt: (s, index) => {
        const chars = codePoints(str("charCodeAt", s));
        const idxNum = num("charCodeAt", index);
        if (!Number.isFinite(idxNum)) fail("charCodeAt", "index must be a finite number");
        const idx = Math.trunc(idxNum);
        if (idx < 0 || idx >= chars.length) return null;
        return chars[idx].codePointAt(0) ?? null;
      },
      fromCharCode: (code) => {
        const c = num("fromCharCode", code);
        if (!Number.isFinite(c) || !Number.isInteger(c) || c < 0 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) {
          fail("fromCharCode", `invalid Unicode code point ${c}`);
        }
        return String.fromCodePoint(c);
      },
      substr: (s, start, length) => {
        const chars = codePoints(str("substr", s));
        const i = Math.trunc(num("substr", start));
        const n = Math.trunc(num("substr", length));
        if (!Number.isFinite(i) || !Number.isFinite(n)) fail("substr", "start and length must be finite numbers");
        if (i < 0) fail("substr", "start index cannot be negative");
        if (n < 0) fail("substr", "length cannot be negative");
        const sub = chars.slice(i, i + n).join("");
        this.checkStringSize(this.utf8ByteLength(sub), nativeToken("substr"));
        return sub;
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
      dateFormat: (ms, pattern) => {
        const msNum = num("dateFormat", ms);
        if (!Number.isFinite(msNum) || msNum < -8.64e15 || msNum > 8.64e15) {
          fail("dateFormat", "timestamp out of range");
        }
        const fmt = pattern === undefined ? "YYYY-MM-DDTHH:mm:ss.SSSZ" : str("dateFormat", pattern);
        const d = new Date(Math.trunc(msNum));
        const rawYear = d.getUTCFullYear();
        const year = rawYear < 0 ? `-${String(-rawYear).padStart(4, "0")}` : String(rawYear).padStart(4, "0");
        const month = String(d.getUTCMonth() + 1).padStart(2, "0");
        const day = String(d.getUTCDate()).padStart(2, "0");
        const hour = String(d.getUTCHours()).padStart(2, "0");
        const min = String(d.getUTCMinutes()).padStart(2, "0");
        const sec = String(d.getUTCSeconds()).padStart(2, "0");
        const millis = String(d.getUTCMilliseconds()).padStart(3, "0");
        let out = "";
        for (let i = 0; i < fmt.length; ) {
          if (fmt.startsWith("YYYY", i)) { out += year; i += 4; }
          else if (fmt.startsWith("MM", i)) { out += month; i += 2; }
          else if (fmt.startsWith("DD", i)) { out += day; i += 2; }
          else if (fmt.startsWith("HH", i)) { out += hour; i += 2; }
          else if (fmt.startsWith("mm", i)) { out += min; i += 2; }
          else if (fmt.startsWith("ss", i)) { out += sec; i += 2; }
          else if (fmt.startsWith("SSS", i)) { out += millis; i += 3; }
          else { out += fmt[i]; i++; }
        }
        this.checkStringSize(this.utf8ByteLength(out), nativeToken("dateFormat"));
        return out;
      },
      dateParse: (s) => {
        const text = str("dateParse", s);
        const m = RE_ISO_DATE.exec(text);
        if (!m) return null;
        const year = Number(m[1]);
        const month = Number(m[2]);
        const day = Number(m[3]);
        if (month < 1 || month > 12 || day < 1 || day > daysInMonthUTC(year, month)) return null;
        let hour = 0, minute = 0, second = 0, milli = 0, offsetMs = 0;
        if (m[4] !== undefined) {
          hour = Number(m[4]);
          minute = Number(m[5]);
          second = m[6] !== undefined ? Number(m[6]) : 0;
          milli = m[7] !== undefined ? Number(m[7].padEnd(3, "0")) : 0;
          if (hour > 23 || minute > 59 || second > 59) return null;
          const tz = m[8];
          if (tz !== "Z") {
            const tzH = Number(tz.slice(1, 3));
            const tzM = Number(tz.slice(4, 6));
            if (tzH > 23 || tzM > 59) return null;
            offsetMs = (tzH * 60 + tzM) * 60_000;
            if (tz[0] === "-") offsetMs = -offsetMs;
          }
        }
        const d = new Date(0);
        d.setUTCFullYear(year, month - 1, day);
        d.setUTCHours(hour, minute, second, milli);
        return d.getTime() - offsetMs;
      },
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
      arrayPush: (a, ...values) => {
        const base = arrayArg("arrayPush", a);
        const newLen = base.length + values.length;
        this.checkCollectionSize(newLen, nativeToken("arrayPush"));
        this.accountAlloc(48 + newLen * 32, nativeToken("arrayPush"));
        return [...base, ...values];
      },
      arrayPop: (a) => {
        const arr = arrayArg("arrayPop", a);
        return arr.length === 0 ? null : arr[arr.length - 1];
      },
      arraySlice: (a, start, end) => {
        const arr = arrayArg("arraySlice", a);
        const lo = Math.max(0, Math.trunc(num("arraySlice", start)));
        const hi = Math.min(arr.length, Math.trunc(num("arraySlice", end)));
        const n = lo > hi ? 0 : hi - lo;
        this.accountAlloc(48 + n * 32, nativeToken("arraySlice"));
        return lo > hi ? [] : arr.slice(lo, hi);
      },
      arrayConcat: (...arrays) => {
        let total = 0;
        for (const a of arrays) total += arrayArg("arrayConcat", a).length;
        this.checkCollectionSize(total, nativeToken("arrayConcat"));
        this.accountAlloc(48 + total * 32, nativeToken("arrayConcat"));
        return arrays.flatMap((a) => arrayArg("arrayConcat", a));
      },
      arrayIndexOf: (a, v) => arrayArg("arrayIndexOf", a).findIndex((x) => valuesEqual(x, v)),
      arrayIncludes: (a, v) => arrayArg("arrayIncludes", a).some((x) => valuesEqual(x, v)),
      arrayJoin: (a, sep) => {
        const arr = arrayArg("arrayJoin", a);
        const delim = sep === undefined ? "," : str("arrayJoin", sep);
        if (arr.length === 0) return "";
        const res = arr.map((el) => (typeof el === "string" ? el : this.stringify(el))).join(delim);
        this.checkStringSize(this.utf8ByteLength(res), nativeToken("arrayJoin"));
        return res;
      },
      arrayMap: (a, fn) => {
        const arr = arrayArg("arrayMap", a);
        this.checkCollectionSize(arr.length, nativeToken("arrayMap"));
        const out = arr.map((el) => callCallback("arrayMap", fn, [el]));
        this.accountAlloc(48 + out.length * 32, nativeToken("arrayMap"));
        return out;
      },
      arrayFilter: (a, fn) => {
        const arr = arrayArg("arrayFilter", a);
        const out: any[] = [];
        for (const el of arr) {
          if (this.isTruthy(callCallback("arrayFilter", fn, [el]))) out.push(el);
        }
        this.accountAlloc(48 + out.length * 32, nativeToken("arrayFilter"));
        return out;
      },
      arrayReduce: (a, fn, initial) => {
        const arr = arrayArg("arrayReduce", a);
        let acc = initial;
        for (const el of arr) {
          acc = callCallback("arrayReduce", fn, [acc, el]);
        }
        return acc;
      },
      arrayFind: (a, fn) => {
        const arr = arrayArg("arrayFind", a);
        for (const el of arr) {
          if (this.isTruthy(callCallback("arrayFind", fn, [el]))) return el;
        }
        return null;
      },
      arraySort: (a, cmp) => {
        const arr = arrayArg("arraySort", a);
        let sorted: any[];
        if (cmp !== undefined) {
          if (!this.isCallable(cmp)) fail("arraySort", `expected function, got ${typeName(cmp)}`);
          const expected = (cmp as PulsarCallable).arity();
          if (expected >= 0 && expected !== 2) {
            const cbName = cmp instanceof PulsarFunction && cmp.functionName ? cmp.functionName : "callback";
            fail("arraySort", `${cbName} expects ${expected} args, got 2`);
          }
          sorted = mergeSort(arr, (x, y) => {
            const res = callCallback("arraySort", cmp, [x, y]);
            if (typeof res !== "number" || Number.isNaN(res)) {
              fail("arraySort", `comparator must return a finite or numeric value, got ${typeName(res)}`);
            }
            return res < 0;
          });
        } else {
          if (arr.length === 0) {
            sorted = [];
          } else {
            const k0 = typeName(arr[0]);
            if (k0 !== "number" && k0 !== "string") {
              fail("arraySort", `default order only supports numbers or strings, got ${k0}`);
            }
            for (let i = 1; i < arr.length; i++) {
              const ki = typeName(arr[i]);
              if (ki !== k0) fail("arraySort", `cannot compare ${k0} and ${ki} without a comparator`);
            }
            if (k0 === "string") {
              sorted = mergeSort(arr, (x, y) => compareStringsByCodePoint(x, y) < 0);
            } else {
              sorted = mergeSort(arr, (x, y) => {
                const xn = Number.isNaN(x);
                const yn = Number.isNaN(y);
                if (xn || yn) return !xn && yn;
                return x < y;
              });
            }
          }
        }
        this.accountAlloc(48 + sorted.length * 32, nativeToken("arraySort"));
        return sorted;
      },
      objKeys: (o) => {
        const keys = sortedKeys(objectArg("objKeys", o));
        this.accountAlloc(48 + keys.length * 32, nativeToken("objKeys"));
        return keys;
      },
      objValues: (o) => {
        const obj = objectArg("objValues", o);
        const keys = sortedKeys(obj);
        this.accountAlloc(48 + keys.length * 32, nativeToken("objValues"));
        return keys.map((k) => obj.get(k));
      },
      objHas: (o, k) => objectArg("objHas", o).has(key(k)),
      objGet: (o, k) => objectArg("objGet", o).get(key(k)) ?? null,
      objSet: (o, k, v) => {
        const obj = objectArg("objSet", o);
        const ks = key(k);
        const newLen = obj.has(ks) ? obj.size : obj.size + 1;
        this.checkCollectionSize(newLen, nativeToken("objSet"));
        this.accountAlloc(48 + newLen * 48, nativeToken("objSet"));
        return new Map(obj).set(ks, v);
      },
      objDelete: (o, k) => {
        const obj = objectArg("objDelete", o);
        const ks = key(k);
        if (!obj.has(ks)) return obj;
        const next = new Map(obj);
        next.delete(ks);
        this.accountAlloc(48 + next.size * 48, nativeToken("objDelete"));
        return next;
      },
      objEntries: (o) => {
        const obj = objectArg("objEntries", o);
        const keys = sortedKeys(obj);
        this.checkCollectionSize(keys.length, nativeToken("objEntries"));
        this.accountAlloc(48 + keys.length * 80, nativeToken("objEntries"));
        return keys.map((k) => [k, obj.get(k)]);
      },
      objMerge: (...objects) => {
        const merged = new Map<string, any>();
        for (const o of objects) {
          const obj = objectArg("objMerge", o);
          for (const [k, v] of obj.entries()) {
            if (!merged.has(k)) this.checkCollectionSize(merged.size + 1, nativeToken("objMerge"));
            merged.set(k, v);
          }
        }
        this.accountAlloc(48 + merged.size * 48, nativeToken("objMerge"));
        return merged;
      },
      jsonParse: (s) => {
        const text = str("jsonParse", s);
        let raw: any;
        try {
          raw = JSON.parse(text);
        } catch (e: any) {
          fail("jsonParse", e?.message ?? "invalid JSON");
        }
        return convertParsedJSON(raw, 0);
      },
      jsonStringify: (v) => {
        const res = serializeJSON(v, 0);
        this.checkStringSize(this.utf8ByteLength(res), nativeToken("jsonStringify"));
        return res;
      },
      // Handlers
      registerHandler: (name, fnOrName) => {
        const handlerKey = str("registerHandler", name);
        if (fnOrName instanceof PulsarFunction) {
          this.handlers.set(handlerKey, fnOrName);
          return null;
        }
        const fn = this.globals.getOwn(str("registerHandler", fnOrName));
        if (!(fn instanceof PulsarFunction)) fail("registerHandler", `handler function not found: ${fnOrName}`);
        this.handlers.set(handlerKey, fn as PulsarFunction);
        return null;
      },
      on: (eventName, fn) => {
        const keyName = str("on", eventName);
        if (!(fn instanceof PulsarFunction)) fail("on", `expected function, got ${typeName(fn)}`);
        const list = this.eventListeners.get(keyName) ?? [];
        list.push(fn);
        this.eventListeners.set(keyName, list);
        return null;
      },
      emit: (name, payload = null) => {
        const eventName = str("emit", name);
        const evt = new Map<string, any>([["name", eventName], ["payload", payload]]);
        if (this.options.events) {
          this.options.events.emit(toHost(evt));
        }
        return null;
      },
      sleep: (ms) => {
        const dur = num("sleep", ms);
        if (!Number.isFinite(dur) || dur < 0) {
          fail("sleep", "argument 1 (ms) must be a finite non-negative number");
        }
        return null;
      },
      yield: () => null,
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
      fsMkdir: (p) => {
        const io = ensureIO("fsMkdir");
        if (!io.mkdir) fail("fsMkdir", "not supported by this host");
        return fromHostResult(io.mkdir!(p));
      },
      fsRename: (from, to) => {
        const io = ensureIO("fsRename");
        if (!io.rename) fail("fsRename", "not supported by this host");
        return fromHostResult(io.rename!(from, to));
      },
      fsCopy: (from, to) => {
        const io = ensureIO("fsCopy");
        if (!io.copy) fail("fsCopy", "not supported by this host");
        return fromHostResult(io.copy!(from, to));
      },
      fsQuota: () => {
        const io = ensureIO("fsQuota");
        if (!io.quota) fail("fsQuota", "not supported by this host");
        return fromHostResult(io.quota!());
      },
      fsReadBase64: (p) => {
        const io = ensureIO("fsReadBase64");
        if (!io.readFileBase64) fail("fsReadBase64", "not supported by this host");
        return fromHostResult(io.readFileBase64!(p));
      },
      fsWriteBase64: (p, data) => {
        const io = ensureIO("fsWriteBase64");
        if (!io.writeFileBase64) fail("fsWriteBase64", "not supported by this host");
        return fromHostResult(io.writeFileBase64!(p, data));
      },
      // Host: events
      emitEvent: (payload = null) => fromHost(ensureEvents("emitEvent").emit(toHost(payload)) ?? null),
      pollEvent: () => fromHost(ensureEvents("pollEvent").poll() ?? null),
      notifyWindow: (payload) => {
        const events = ensureEvents("notifyWindow");
        if (!events.notifyWindow) fail("notifyWindow", "not supported by this host");
        events.notifyWindow!(toHost(payload));
        return null;
      },
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
        call: (_: Interpreter, args: any[], callLine = 0) => {
          const prevCallLine = this.currentCallLine;
          this.currentCallLine = callLine;
          try {
            const arity = arityError(fn, args.length);
            if (arity) throw this.createRuntimeError(nativeToken(fn.name), arity);
            if (this.options.strictTypes) this.checkArgTypes(fn, args, nativeToken(fn.name));
            return impl(...args);
          } finally {
            this.currentCallLine = prevCallLine;
          }
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

  /** Names registered with on(), sorted alphabetically (LANG-10). */
  eventListenerNames(): string[] {
    return [...this.eventListeners.keys()].filter((k) => (this.eventListeners.get(k)?.length ?? 0) > 0).sort();
  }

  /** Invokes all listeners registered for an event via on(), in registration order (LANG-10). */
  dispatchEvent(name: string, payload: any = null): void {
    const orig = this.eventListeners.get(name);
    if (!orig || orig.length === 0) return;
    const listeners = [...orig];
    this.resetBudget();
    const arg = fromHost(payload);
    for (const fn of listeners) {
      const arity = fn.arity();
      if (arity === 0) {
        fn.call(this, []);
      } else if (arity === 1) {
        fn.call(this, [arg]);
      } else {
        throw new Error(`event ${name} listener expects 0 or 1 args, got ${arity}`);
      }
    }
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

  private utf8ByteLength(s: string): number {
    if (typeof Buffer !== "undefined") return Buffer.byteLength(s, "utf8");
    return this.textEncoder.encode(s).length;
  }

  private memLimitError(token: Token | undefined, message: string): MemoryLimitError {
    const tok = token ?? ({ type: TokenType.IDENTIFIER, lexeme: "", literal: null, line: 0 } as Token);
    return new MemoryLimitError(tok, message, [...this.callStack]);
  }

  protected checkStringSize(byteLen: number, token?: Token): void {
    const maxStr = this.limits.maxStringBytes;
    if (maxStr > 0 && Number.isFinite(maxStr) && byteLen > maxStr) {
      throw this.memLimitError(token, `string length ${byteLen} exceeds limit of ${maxStr} bytes`);
    }
    this.accountAlloc(byteLen + 16, token);
  }

  protected checkCollectionSize(len: number, token?: Token): void {
    const maxLen = this.limits.maxCollectionLen;
    if (maxLen > 0 && Number.isFinite(maxLen) && len > maxLen) {
      throw this.memLimitError(token, `collection length ${len} exceeds limit of ${maxLen} elements`);
    }
  }

  protected accountAlloc(deltaBytes: number, token?: Token): void {
    const maxMem = this.limits.maxMemoryBytes;
    if (!(maxMem > 0 && Number.isFinite(maxMem))) return;
    this.memBytes += deltaBytes;
    if (this.memBytes > maxMem) {
      const liveBytes = this.recomputeLiveMemory();
      this.memBytes = liveBytes + deltaBytes;
      if (this.memBytes > maxMem) {
        throw this.memLimitError(token, `allocated memory ${this.memBytes} exceeds limit of ${maxMem} bytes`);
      }
    }
  }

  protected accountValue(root: any, token?: Token): any {
    const maxStr = this.limits.maxStringBytes;
    const maxLen = this.limits.maxCollectionLen;
    const maxMem = this.limits.maxMemoryBytes;
    const hasStr = maxStr > 0 && Number.isFinite(maxStr);
    const hasLen = maxLen > 0 && Number.isFinite(maxLen);
    const hasMem = maxMem > 0 && Number.isFinite(maxMem);
    if (!hasStr && !hasLen && !hasMem) return root;

    let bytes = 0;
    const seen = new Set<any>();
    const stack: any[] = [root];
    while (stack.length > 0) {
      const v = stack.pop();
      if (typeof v === "string") {
        const b = this.utf8ByteLength(v);
        if (hasStr && b > maxStr) {
          throw this.memLimitError(token, `string length ${b} exceeds limit of ${maxStr} bytes`);
        }
        bytes += b + 16;
      } else if (isArray(v)) {
        if (seen.has(v)) continue;
        seen.add(v);
        if (hasLen && v.length > maxLen) {
          throw this.memLimitError(token, `collection length ${v.length} exceeds limit of ${maxLen} elements`);
        }
        bytes += 48 + v.length * 32;
        for (const el of v) stack.push(el);
      } else if (isObject(v)) {
        if (seen.has(v)) continue;
        seen.add(v);
        if (hasLen && v.size > maxLen) {
          throw this.memLimitError(token, `collection length ${v.size} exceeds limit of ${maxLen} elements`);
        }
        bytes += 48 + v.size * 48;
        for (const [k, val] of v.entries()) {
          bytes += this.utf8ByteLength(k) + 16;
          stack.push(val);
        }
      }
    }
    this.accountAlloc(bytes, token);
    return root;
  }

  private recomputeLiveMemory(): number {
    let bytes = 0;
    const seen = new Set<any>();
    const stack: any[] = [];
    const visitEnv = (env: Environment | null) => {
      while (env && !seen.has(env)) {
        seen.add(env);
        for (const val of (env as any).values.values()) {
          stack.push(val);
        }
        env = env.enclosing;
      }
    };
    visitEnv(this.environment);
    visitEnv(this.globals);
    for (const fn of this.handlers.values()) {
      visitEnv((fn as any).closure ?? null);
    }
    while (stack.length > 0) {
      const v = stack.pop();
      if (typeof v === "string") {
        bytes += this.utf8ByteLength(v) + 16;
      } else if (isArray(v)) {
        if (seen.has(v)) continue;
        seen.add(v);
        bytes += 48 + v.length * 32;
        for (const el of v) stack.push(el);
      } else if (isObject(v)) {
        if (seen.has(v)) continue;
        seen.add(v);
        bytes += 48 + v.size * 48;
        for (const [k, val] of v.entries()) {
          bytes += this.utf8ByteLength(k) + 16;
          stack.push(val);
        }
      } else if (v && typeof v === "object" && "closure" in v) {
        if (seen.has(v)) continue;
        seen.add(v);
        bytes += 64;
        visitEnv(v.closure);
      }
    }
    return bytes;
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

  interpret(statements: Stmt[], sources: string[] = []): void {
    this.sources = sources;
    this.currentFileIndex = 0;
    this.resetBudget();
    try {
      // Hoist top-level functions so they can be called before their declaration (SPEC 4.6, D2).
      for (const raw of statements) {
        const statement = raw instanceof ExportStmt && raw.declaration ? raw.declaration : raw;
        if (statement instanceof FunctionStmt) {
          const prevFile = this.currentFileIndex;
          if (typeof (raw as any).sourceIndex === "number") {
            this.currentFileIndex = (raw as any).sourceIndex;
          }
          try {
            this.execute(statement);
          } finally {
            this.currentFileIndex = prevFile;
          }
        }
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
      if (this.runLoopBody(stmt.body) === "break") break;
    }
  }

  /** Runs one iteration's body; reports a `break` so the loop can stop (`continue` just ends the body). */
  private runLoopBody(body: Stmt): "break" | null {
    try {
      this.execute(body);
    } catch (err) {
      if (err instanceof LoopSignal) return err.isContinue ? null : "break";
      throw err;
    }
    return null;
  }

  visitBreakStmt(stmt: BreakStmt): void {
    throw new LoopSignal(stmt.isContinue);
  }

  visitForOfStmt(stmt: ForOfStmt): void {
    const iterable = this.evaluate(stmt.iterable);
    let items: any[];
    if (isArray(iterable)) items = iterable;
    else if (isObject(iterable)) {
      this.checkCollectionSize(iterable.size, stmt.name);
      this.accountAlloc(48 + iterable.size * 32, stmt.name);
      items = sortedKeys(iterable);
    }
    else if (typeof iterable === "string") {
      items = Array.from(iterable);
      this.checkCollectionSize(items.length, stmt.name);
      this.accountAlloc(48 + items.length * 48, stmt.name);
    }
    else throw this.createRuntimeError(stmt.name, `for...of needs an array, object or string, got ${typeName(iterable)}`);

    const previous = this.environment;
    try {
      for (const item of items) {
        this.tick();
        this.environment = new Environment(previous);
        this.environment.define(stmt.name.lexeme, item);
        if (this.runLoopBody(stmt.body) === "break") break;
      }
    } finally {
      this.environment = previous;
    }
  }

  visitIndexExpr(expr: IndexExpr): any {
    const container = this.evaluate(expr.object);
    const key = this.evaluate(expr.index);
    return this.readElement(container, key, expr);
  }

  /** container[key] with the rules the VM's INDEX_GET follows (SPEC 4.8). */
  private readElement(container: any, key: any, expr: IndexExpr): any {
    if (isObject(container)) {
      if (typeof key !== "string") {
        throw this.createRuntimeError(expr.token, `object keys must be strings, got ${typeName(key)}`);
      }
      return container.has(key) ? container.get(key) : null;
    }
    if (expr.member) {
      throw this.createRuntimeError(expr.token, `cannot read property '${key}' of ${typeName(container)}`);
    }
    if (isArray(container) || typeof container === "string") {
      const items = isArray(container) ? container : Array.from(container);
      const i = this.indexOf(key, items.length, expr.token, false);
      return items[i];
    }
    throw this.createRuntimeError(expr.token, `cannot index ${typeName(container)}`);
  }

  /** Validates an array or string index; `forWrite` also allows appending at the end. */
  private indexOf(key: any, length: number, token: Token, forWrite: boolean): number {
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw this.createRuntimeError(token, `index must be an integer, got ${typeof key === "number" ? String(key) : typeName(key)}`);
    }
    if (key < 0 || key > length || (key === length && !forWrite)) {
      throw this.createRuntimeError(token, `index ${key} out of bounds (length ${length})`);
    }
    return key;
  }

  /** A copy of `container` with `container[key] = value` (arrays and objects are values, SPEC 3.3). */
  private withElement(container: any, key: any, value: any, expr: IndexExpr): any {
    if (isObject(container)) {
      if (typeof key !== "string") {
        throw this.createRuntimeError(expr.token, `object keys must be strings, got ${typeName(key)}`);
      }
      const newLen = container.has(key) ? container.size : container.size + 1;
      this.checkCollectionSize(newLen, expr.token);
      this.accountAlloc(48 + newLen * 48, expr.token);
      const next = new Map(container);
      next.set(key, value);
      return next;
    }
    if (isArray(container) && !expr.member) {
      const i = this.indexOf(key, container.length, expr.token, true);
      const newLen = i === container.length ? container.length + 1 : container.length;
      this.checkCollectionSize(newLen, expr.token);
      this.accountAlloc(48 + newLen * 32, expr.token);
      const next = container.slice();
      next[i] = value;
      return next;
    }
    throw this.createRuntimeError(expr.token, `cannot set an element of ${typeName(container)}`);
  }

  visitSetIndexExpr(expr: SetIndex): any {
    // Unwind root.a.b[k] into root and steps [a, b, k] so every key expression evaluates once.
    const steps: IndexExpr[] = [];
    let node: Expr = expr.target;
    while (node instanceof IndexExpr) {
      steps.push(node);
      node = node.object;
    }
    steps.reverse();
    const rootVar = node as Variable;

    const keys = steps.map((s) => this.evaluate(s.index));
    const rootVal = this.environment.get(rootVar.name);
    const containers: any[] = new Array(steps.length);
    let cur = rootVal;
    for (let i = 0; i < steps.length; i++) {
      containers[i] = cur;
      if (i < steps.length - 1 || expr.operator !== null) {
        cur = this.readElement(cur, keys[i], steps[i]);
      }
    }

    const rhs = this.evaluate(expr.value);
    const leafValue = expr.operator !== null ? this.applyBinaryOp(expr.operator, cur, rhs) : rhs;

    let updated = leafValue;
    for (let i = steps.length - 1; i >= 0; i--) {
      updated = this.withElement(containers[i], keys[i], updated, steps[i]);
    }
    this.environment.assign(rootVar.name, updated);
    return null;
  }

  visitTernaryExpr(expr: TernaryExpr): any {
    if (this.isTruthy(this.evaluate(expr.condition))) {
      return this.evaluate(expr.thenBranch);
    }
    return this.evaluate(expr.elseBranch);
  }

  visitTemplateLiteralExpr(expr: TemplateLiteralExpr): any {
    let out = "";
    for (const part of expr.parts) {
      const piece = this.stringify(this.evaluate(part));
      this.checkStringSize(this.utf8ByteLength(out) + this.utf8ByteLength(piece), expr.token);
      out += piece;
    }
    return out;
  }

  visitFunctionExpr(expr: FunctionExpr): any {
    this.accountAlloc(64, expr.keyword);
    return new PulsarFunction(expr, this.environment);
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
        if (this.runLoopBody(stmt.body) === "break") break;

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
    return this.applyBinaryOp(expr.operator, left, right);
  }

  private applyBinaryOp(operator: Token, left: any, right: any): any {
    switch (operator.type) {
      case TokenType.MINUS:
        if (this.options.strictTypes) {
          this.checkNumberOperands(operator, left, right);
          return (left as number) - (right as number);
        }
        this.checkNumberOperands(operator, left, right);
        return Number(left) - Number(right);
      case TokenType.PLUS:
        // Adds two numbers; concatenates printed forms when either side is a string (SPEC §4.2, D6).
        if (typeof left === 'number' && typeof right === 'number') {
          return left + right;
        }
        if (typeof left === 'string' || typeof right === 'string') {
          const ls = typeof left === "string" ? left : this.stringify(left);
          const rs = typeof right === "string" ? right : this.stringify(right);
          this.checkStringSize(this.utf8ByteLength(ls) + this.utf8ByteLength(rs), operator);
          return ls + rs;
        }
        throw this.createRuntimeError(operator, "Operands must be two numbers, or include a string.");
      case TokenType.PERCENT:
        this.checkNumberOperands(operator, left, right);
        if ((right as number) === 0) {
          throw this.createRuntimeError(operator, "modulo by zero");
        }
        // Remainder with the sign of the dividend, as in C, Go and JavaScript.
        return (left as number) % (right as number);
      case TokenType.SLASH:
        if (this.options.strictTypes) {
          this.checkNumberOperands(operator, left, right);
          if ((right as number) === 0) {
            throw this.createRuntimeError(operator, "Division by zero.");
          }
          return (left as number) / (right as number);
        }
        this.checkNumberOperands(operator, left, right);
        if (Number(right) === 0) {
          throw this.createRuntimeError(operator, "Division by zero.");
        }
        return Number(left) / Number(right);
      case TokenType.STAR:
        if (this.options.strictTypes) {
          this.checkNumberOperands(operator, left, right);
          return (left as number) * (right as number);
        }
        this.checkNumberOperands(operator, left, right);
        return Number(left) * Number(right);
      case TokenType.GREATER:
        if (typeof left === "string" && typeof right === "string") {
          return compareStringsByCodePoint(left, right) > 0;
        }
        if (this.options.strictTypes) {
          this.checkNumberOperands(operator, left, right);
          return (left as number) > (right as number);
        }
        this.checkNumberOperands(operator, left, right);
        return Number(left) > Number(right);
      case TokenType.GREATER_EQUAL:
        if (typeof left === "string" && typeof right === "string") {
          return compareStringsByCodePoint(left, right) >= 0;
        }
        if (this.options.strictTypes) {
          this.checkNumberOperands(operator, left, right);
          return (left as number) >= (right as number);
        }
        this.checkNumberOperands(operator, left, right);
        return Number(left) >= Number(right);
      case TokenType.LESS:
        if (typeof left === "string" && typeof right === "string") {
          return compareStringsByCodePoint(left, right) < 0;
        }
        if (this.options.strictTypes) {
          this.checkNumberOperands(operator, left, right);
          return (left as number) < (right as number);
        }
        this.checkNumberOperands(operator, left, right);
        return Number(left) < Number(right);
      case TokenType.LESS_EQUAL:
        if (typeof left === "string" && typeof right === "string") {
          return compareStringsByCodePoint(left, right) <= 0;
        }
        if (this.options.strictTypes) {
          this.checkNumberOperands(operator, left, right);
          return (left as number) <= (right as number);
        }
        this.checkNumberOperands(operator, left, right);
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

    const at = expr.callee instanceof Variable ? expr.callee.name : expr.paren;
    try {
      return func.call(this, args, at.line);
    } catch (err) {
      if (err instanceof MemoryLimitError && !(err.token?.line > 0)) {
        const at = expr.callee instanceof Variable ? expr.callee.name : expr.paren;
        const wrapped = new MemoryLimitError(at, err.message, err.callStack);
        (wrapped as any).sourceFile = (err as any).sourceFile ?? this.currentSourceFile();
        throw wrapped;
      }
      // Built-ins raise errors without a source position; report them at the call.
      if (err instanceof RuntimeError && !(err.token?.line > 0) && !(err instanceof BudgetError) && !(err instanceof MemoryLimitError)) {
        // The line of the function name, as the VM's line map reports it (D18).
        const at = expr.callee instanceof Variable ? expr.callee.name : expr.paren;
        const wrapped = new RuntimeError(at, err.message, err.callStack);
        (wrapped as any).sourceFile = (err as any).sourceFile ?? this.currentSourceFile();
        throw wrapped;
      }
      throw err;
    }
  }

  visitArrayExpr(expr: ArrayExpr): any {
    this.checkCollectionSize(expr.elements.length);
    this.accountAlloc(48 + expr.elements.length * 32);
    return expr.elements.map((e) => this.evaluate(e));
  }

  visitObjectExpr(expr: ObjectExpr): any {
    this.checkCollectionSize(expr.properties.length);
    this.accountAlloc(48 + expr.properties.length * 48);
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
      // `return` inside try is not an error (D19), and budgets/memory caps cannot be caught (D10, LANG-01).
      if (err instanceof ReturnException || err instanceof BudgetError || err instanceof MemoryLimitError || err instanceof LoopSignal) throw err;
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

  visitImportStmt(stmt: ImportStmt): void {
    throw this.createRuntimeError(stmt.keyword, "Imports must be resolved before running.");
  }

  visitExportStmt(stmt: ExportStmt): void {
    if (stmt.declaration) {
      this.execute(stmt.declaration);
    }
  }

  popCallFrame(): void {
    this.callStack.pop();
  }

  currentSourceFile(): string | undefined {
    return this.sources.length > 1 ? this.sources[this.currentFileIndex] : undefined;
  }

  enterFile(sourceIndex?: number): number {
    const prev = this.currentFileIndex;
    if (typeof sourceIndex === "number") {
      this.currentFileIndex = sourceIndex;
    }
    return prev;
  }

  exitFile(prev: number): void {
    this.currentFileIndex = prev;
  }

  createRuntimeError(token: Token, message: string): RuntimeError {
    const err = new RuntimeError(token, message, [...this.callStack]);
    (err as any).sourceFile = this.currentSourceFile();
    return err;
  }

  private execute(stmt: Stmt): void {
    this.tick();
    const prevFile = this.currentFileIndex;
    if (typeof (stmt as any).sourceIndex === "number") {
      this.currentFileIndex = (stmt as any).sourceIndex;
    }
    try {
      stmt.accept(this);
    } finally {
      this.currentFileIndex = prevFile;
    }
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
   * The value bound by catch (SPEC §7, D7, LANG-06): {kind: "runtime", line, message, stack}.
   * `line` is nil when the position is unknown.
   */
  private errorToValue(err: any): Map<string, any> {
    let line: number | null = null;
    let message: string;
    let frames: CallFrame[] = [];
    if (err instanceof RuntimeError) {
      message = err.message;
      line = err.token?.line > 0 ? err.token.line : null;
      frames = err.callStack ?? [];
    } else if (err instanceof RangeError) {
      message = "Stack overflow.";
    } else if (err instanceof Error) {
      message = err.message;
    } else {
      message = this.stringify(err);
    }
    const displayName = (n: string): string => n.replace(/^__m\d+\$/, "");
    const formatLoc = (file: string | undefined, ln: number | null): string => {
      if (file && ln !== null && ln > 0) return `${file}:${ln}`;
      if (ln !== null && ln > 0) return `line ${ln}`;
      return "";
    };
    const errFile: string | undefined = err?.sourceFile ?? this.currentSourceFile();
    const stack: string[] = [];
    const activeName = frames.length > 0 ? displayName(frames[frames.length - 1].functionName) : "<script>";
    const activeLoc = formatLoc(errFile, line);
    stack.push(activeLoc ? `${activeName} (${activeLoc})` : activeName);
    for (let i = frames.length - 1; i >= 0; i--) {
      const caller = i === 0 ? "<script>" : displayName(frames[i - 1].functionName);
      const callLoc = formatLoc(frames[i].callFile, frames[i].callLine ?? frames[i].line);
      stack.push(callLoc ? `${caller} (${callLoc})` : caller);
    }
    return new Map<string, any>([["kind", "runtime"], ["line", line], ["message", message], ["stack", stack]]);
  }
}

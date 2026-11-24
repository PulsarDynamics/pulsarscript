import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface WasmRunOptions {
  mockHost?: boolean;
  seedMockFS?: boolean;
  capabilities?: Record<string, boolean>;
  autoResumeYield?: boolean;
  seed?: number;
  maxSteps?: number;
  maxDurationMs?: number;
  maxStringBytes?: number;
  maxCollectionLen?: number;
  maxMemoryBytes?: number;
  maxHeapCount?: number;
}

export interface WasmMockHostCall {
  name: string;
  capability: string;
  args: unknown[];
  result: unknown;
  mock: boolean;
}

export interface WasmRunResult {
  ok: boolean;
  stage: "ok" | "load" | "capability" | "memory" | "budget" | "runtime";
  output: string;
  prints: string[];
  error?: string;
  errorLine?: number;
  handlers: string[];
  eventListeners: string[];
  events: string[] | null;
  deniedCalls: string[] | null;
  mockHostCalls: WasmMockHostCall[] | null;
  stats: {
    steps: number;
    maxSteps: number;
    memBytes: number;
    maxMemoryBytes: number;
    heapObjects: number;
    durationMs: number;
    maxDurationMs: number;
    codeLen: number;
    constantsLen: number;
    functionsLen: number;
  };
}

export interface WasmDebugVar {
  name: string;
  type: string;
  value: string;
}

export interface WasmDebugFrame {
  index: number;
  name: string;
  file?: string;
  line: number;
  ip: number;
  locals: WasmDebugVar[];
  upvalues?: WasmDebugVar[];
}

export interface WasmDebugSnapshot {
  reason: string;
  ip: number;
  line: number;
  file?: string;
  opcode?: string;
  steps: number;
  maxSteps: number;
  elapsedMs: number;
  maxDurationMs: number;
  memBytes: number;
  maxMemoryBytes: number;
  heapObjects: number;
  halted: boolean;
  yielded?: boolean;
  suspended?: boolean;
  error?: string;
  stackDepth: number;
  frames: WasmDebugFrame[];
  globals: WasmDebugVar[];
}

export interface WasmDebugActionResult {
  ok: boolean;
  error?: string;
  snapshot: WasmDebugSnapshot;
  prints: string[];
  output: string;
  mockHostCalls: WasmMockHostCall[] | null;
  deniedCalls: string[] | null;
}

interface RawPulsarWasmGlobal {
  version: string;
  verifyModule(bytecodeJson: string): string;
  disassemble(bytecodeJson: string): string;
  runAsync(bytecodeJson: string, optsJson?: string): Promise<string>;
  createSession(bytecodeJson: string, optsJson?: string): string;
  dispatchHandlerAsync(sessionId: number, handler: string, argsJson: string): Promise<string>;
  disposeSession(sessionId: number): void;
  createDebugSession(bytecodeJson: string, optsJson?: string): string;
  debugSetBreakpoints(sessionId: number, breakpointsJson: string): string;
  debugContinue(sessionId: number): Promise<string>;
  debugStepIn(sessionId: number): Promise<string>;
  debugStepOver(sessionId: number): Promise<string>;
  debugStepOut(sessionId: number): Promise<string>;
  debugStepInstruction(sessionId: number): Promise<string>;
  debugSnapshot(sessionId: number): string;
  debugDispose(sessionId: number): void;
}

export class PulsarWasmClient {
  constructor(private readonly raw: RawPulsarWasmGlobal) {}

  get version(): string {
    return this.raw.version;
  }

  verifyModule(bytecodeJson: string): {
    ok: boolean;
    error?: string;
    version?: number;
    compiler?: string;
    sourceHash?: string;
    codeLen?: number;
    constantsLen?: number;
    functions?: number;
  } {
    return JSON.parse(this.raw.verifyModule(bytecodeJson));
  }

  disassemble(bytecodeJson: string): { ok: boolean; text?: string; error?: string } {
    return JSON.parse(this.raw.disassemble(bytecodeJson));
  }

  async runBytecode(bytecodeJson: string, opts: WasmRunOptions = {}): Promise<WasmRunResult> {
    const res = await this.raw.runAsync(bytecodeJSONOrStr(bytecodeJson), JSON.stringify(opts));
    return JSON.parse(res) as WasmRunResult;
  }

  createSession(bytecodeJson: string, opts: WasmRunOptions = {}) {
    const init = JSON.parse(this.raw.createSession(bytecodeJson, JSON.stringify(opts))) as {
      ok: boolean;
      sessionId?: number;
      handlers?: string[];
      error?: string;
    };
    if (!init.ok || init.sessionId === undefined) {
      throw new Error(init.error ?? "failed to create WASM session");
    }
    const id = init.sessionId;
    return {
      handlers: init.handlers ?? [],
      dispatchHandler: async (name: string, args: unknown[] = []) => {
        const raw = await this.raw.dispatchHandlerAsync(id, name, JSON.stringify(args));
        return JSON.parse(raw) as {
          ok: boolean;
          result?: unknown;
          error?: string;
          stage?: string;
          prints?: string[];
          durationMs?: number;
        };
      },
      dispose: () => this.raw.disposeSession(id),
    };
  }

  createDebugSession(bytecodeJson: string, opts: WasmRunOptions = {}) {
    const init = JSON.parse(this.raw.createDebugSession(bytecodeJson, JSON.stringify(opts))) as {
      ok: boolean;
      sessionId?: number;
      snapshot?: WasmDebugSnapshot;
      error?: string;
    };
    if (!init.ok || init.sessionId === undefined || !init.snapshot) {
      throw new Error(init.error ?? "failed to create WASM debug session");
    }
    const id = init.sessionId;
    return {
      initialSnapshot: init.snapshot,
      setBreakpoints: (breakpoints: { file?: string; line: number }[]) =>
        JSON.parse(this.raw.debugSetBreakpoints(id, JSON.stringify(breakpoints))) as {
          ok: boolean;
          breakpoints?: { file?: string; line: number }[];
          error?: string;
        },
      continue: async () => JSON.parse(await this.raw.debugContinue(id)) as WasmDebugActionResult,
      stepIn: async () => JSON.parse(await this.raw.debugStepIn(id)) as WasmDebugActionResult,
      stepOver: async () => JSON.parse(await this.raw.debugStepOver(id)) as WasmDebugActionResult,
      stepOut: async () => JSON.parse(await this.raw.debugStepOut(id)) as WasmDebugActionResult,
      stepInstruction: async () =>
        JSON.parse(await this.raw.debugStepInstruction(id)) as WasmDebugActionResult,
      snapshot: () => JSON.parse(this.raw.debugSnapshot(id)) as WasmDebugActionResult,
      dispose: () => this.raw.debugDispose(id),
    };
  }
}

function bytecodeJSONOrStr(input: string | object): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

let cachedPromise: Promise<PulsarWasmClient> | null = null;

/**
 * Load site/wasm_exec.js and instantiate site/pulsarvm.wasm once in Bun/Node.
 */
export function loadPulsarWasmVM(wasmPath?: string): Promise<PulsarWasmClient> {
  if (!wasmPath && cachedPromise) return cachedPromise;
  const loader = (async () => {
    const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
    const targetWasm = wasmPath ?? join(repoRoot, "site", "pulsarvm.wasm");
    const wasmExec = join(dirname(targetWasm), "wasm_exec.js");
    if (!existsSync(targetWasm)) {
      throw new Error(`Missing WASM binary at ${targetWasm}. Run: bun run build:wasm`);
    }
    if (!existsSync(wasmExec)) {
      throw new Error(`Missing Go wasm_exec.js at ${wasmExec}. Run: bun run build:wasm`);
    }

    if (!(globalThis as unknown as { Go?: unknown }).Go) {
      const execCode = readFileSync(wasmExec, "utf8");
      new Function(execCode)();
    }

    const GoCtor = (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(inst: WebAssembly.Instance): Promise<void> } }).Go;
    const go = new GoCtor();
    const bytes = readFileSync(targetWasm);
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    void go.run(instance);

    for (let i = 0; i < 100; i++) {
      const api = (globalThis as unknown as { PulsarWasmVM?: RawPulsarWasmGlobal }).PulsarWasmVM;
      if (api) return new PulsarWasmClient(api);
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("Timed out waiting for PulsarWasmVM initialization");
  })();

  if (!wasmPath) cachedPromise = loader;
  return loader;
}

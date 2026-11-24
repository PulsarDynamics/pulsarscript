import { Opcode, type Chunk, type FunctionEntry, type UpvalueDesc } from "./Bytecode";
import type { Stmt } from "./interfaces/Stmt";
import type { Expr } from "./interfaces/Expr";
import type { ExprVisitor } from "./interfaces/ExprVisitor";
import type { StmtVisitor } from "./interfaces/StmtVisitor";
import { Literal } from "./classes/Literal";
import { Unary } from "./classes/Unary";
import { Binary } from "./classes/Binary";
import { Grouping } from "./classes/Grouping";
import { ExpressionStmt } from "./classes/ExpressionStmt";
import { PrintStmt } from "./classes/PrintStmt";
import { TokenType } from "./enums/TokenType";
import { compareStringsByCodePoint } from "./Values";
import { VarStmt } from "./classes/VarStmt";
import { Variable } from "./classes/Variable";
import { Assign } from "./classes/Assign";
import { IfStmt } from "./classes/IfStmt";
import { WhileStmt } from "./classes/WhileStmt";
import { ForStmt } from "./classes/ForStmt";
import { FunctionStmt } from "./classes/FunctionStmt";
import { ReturnStmt } from "./classes/ReturnStmt";
import { SemanticError } from "./SemanticAnalyzer";
import { arityError, lookupHostFunction } from "./HostApi";
import { TryCatchStmt } from "./classes/TryCatchStmt";
import { ArrayExpr } from "./classes/ArrayExpr";
import { ObjectExpr } from "./classes/ObjectExpr";
import { IndexExpr } from "./classes/IndexExpr";
import type { SetIndex } from "./classes/SetIndex";
import type { BreakStmt } from "./classes/BreakStmt";
import type { ForOfStmt } from "./classes/ForOfStmt";
import type { TernaryExpr } from "./classes/TernaryExpr";
import type { TemplateLiteralExpr } from "./classes/TemplateLiteralExpr";
import type { FunctionExpr } from "./classes/FunctionExpr";
import type { ImportStmt } from "./classes/ImportStmt";
import { ExportStmt } from "./classes/ExportStmt";
import type { Token } from "./interfaces/Token";

/** A `break` or `continue` waiting for its loop to finish compiling. */
interface PendingJump {
  /** Position of the EXIT_BLOCK whose operand is the size of the blocks it leaves. */
  exitPos: number;
  /** ENTER_BLOCK positions of the blocks it leaves, patched once they close. */
  blocks: number[];
  /** Position of the JUMP to patch (forward jumps only). */
  jumpPos: number;
}

interface LoopContext {
  breaks: PendingJump[];
  continues: PendingJump[];
  /** Where `continue` jumps; null while it is not known yet (for and for-of increments). */
  continueTarget: number | null;
  /** openBlocks.length and tryDepth when the loop body starts. */
  blockDepth: number;
  tryDepth: number;
}

interface CompilerFrame {
  scopeStack: Map<string, number>[];
  nextLocal: number;
  localNames: string[];
  loops: LoopContext[];
  openBlocks: number[];
  tryDepth: number;
  upvalues: UpvalueDesc[];
}

export interface CompileOptions {
  debug?: boolean;
}

function makeFrame(): CompilerFrame {
  return {
    scopeStack: [new Map()],
    nextLocal: 0,
    localNames: [],
    loops: [],
    openBlocks: [],
    tryDepth: 0,
    upvalues: [],
  };
}

/**
 * Bytecode compiler supporting variables, closures/upvalues, control flow, and host calls.
 */
export class BytecodeCompiler implements ExprVisitor<void>, StmtVisitor<void> {
  chunk: Chunk = { constants: [], code: [], functions: [], lineMap: [] };
  frames: CompilerFrame[] = [makeFrame()];
  functions: Map<string, FunctionEntry> = new Map();
  /** Top-level function names, collected before code generation so calls can precede declarations (D2). */
  hoisted: Set<string> = new Set();
  /** CALL operands emitted before their callee was compiled; patched in compile(). */
  callFixups: { operandPos: number; name: string }[] = [];
  /** Every top-level `var` name in the file, collected up front: these are the globals (SPEC 6, D1). */
  globalNames: Set<string> = new Set();
  /** Globals declared so far, to reject a second top-level `var` of the same name. */
  declaredGlobals: Set<string> = new Set();
  /** Constant-pool deduplication index by typed canonical key (LANG-07). */
  private constPoolIndex = new Map<string, number>();
  currentLine = 1; // Track current source line for error mapping
  private currentFileIndex = 0;
  private trackFiles = false;
  private emitDebug = false;

  private get frame(): CompilerFrame { return this.frames[this.frames.length - 1]; }
  private get scopeStack(): Map<string, number>[] { return this.frame.scopeStack; }
  private get nextLocal(): number { return this.frame.nextLocal; }
  private set nextLocal(v: number) { this.frame.nextLocal = v; }
  private get functionDepth(): number { return this.frames.length - 1; }
  private get tryDepth(): number { return this.frame.tryDepth; }
  private set tryDepth(v: number) { this.frame.tryDepth = v; }
  private get loops(): LoopContext[] { return this.frame.loops; }
  private get openBlocks(): number[] { return this.frame.openBlocks; }

  static compile(statements: Stmt[], sources?: string[], opts?: CompileOptions): Chunk {
    const compiler = new BytecodeCompiler();
    compiler.compile(statements, sources, opts);
    return compiler.chunk;
  }

  compile(statements: Stmt[], sources?: string[], opts?: CompileOptions): void {
    this.emitDebug = Boolean(opts?.debug);
    if (sources && sources.length > 1) {
      this.chunk.sources = [...sources];
      this.chunk.fileMap = [];
      this.trackFiles = true;
    }
    // Hoist: every top-level function is callable from anywhere in the file (SPEC 4.6, D2).
    for (const raw of statements) {
      const stmt = raw instanceof ExportStmt && raw.declaration ? raw.declaration : raw;
      if (stmt instanceof FunctionStmt) this.hoisted.add(stmt.name.lexeme);
      if (stmt instanceof VarStmt) this.globalNames.add(stmt.name.lexeme);
    }
    for (const stmt of statements) {
      this.compileNode(stmt);
    }
    this.emit(Opcode.HALT);
    for (const fix of this.callFixups) {
      const fn = this.functions.get(fix.name);
      if (!fn) throw new Error(`internal: hoisted function '${fix.name}' was never compiled`);
      this.chunk.code[fix.operandPos] = fn.address;
    }
  }

  private compileNode(node: any): void {
    const saved = this.currentLine;
    const savedFile = this.currentFileIndex;
    const line = BytecodeCompiler.lineOf(node);
    if (line > 0) this.currentLine = line;
    if (typeof node?.sourceIndex === "number") {
      this.currentFileIndex = node.sourceIndex;
    }
    try {
      node.accept(this);
    } finally {
      this.currentLine = saved;
      this.currentFileIndex = savedFile;
    }
  }

  private static lineOf(node: any): number {
    return node?.line ?? node?.operator?.line ?? node?.keyword?.line ?? node?.name?.line ?? node?.callee?.name?.line ?? node?.paren?.line ?? 0;
  }

  private emit(op: Opcode, operand?: number) {
    this.chunk.code.push(op);
    this.chunk.lineMap!.push(this.currentLine);
    if (this.trackFiles) this.chunk.fileMap!.push(this.currentFileIndex);
    if (operand !== undefined) {
      this.chunk.code.push(operand);
      this.chunk.lineMap!.push(this.currentLine);
      if (this.trackFiles) this.chunk.fileMap!.push(this.currentFileIndex);
    }
  }

  private emitJump(target: number) {
    const offset = target - (this.chunk.code.length + 2);
    this.emit(Opcode.JUMP, offset);
  }

  private addConstant(value: any): number {
    let key: string | null = null;
    if (value === null) key = "nil";
    else if (typeof value === "boolean") key = value ? "b:1" : "b:0";
    else if (typeof value === "string") key = "s:" + value;
    else if (typeof value === "number") {
      key = Number.isNaN(value) ? "n:NaN" : Object.is(value, -0) ? "n:-0" : "n:" + String(value);
    }
    if (key !== null) {
      const existing = this.constPoolIndex.get(key);
      if (existing !== undefined) return existing;
    }
    const idx = this.chunk.constants.length;
    this.chunk.constants.push(value);
    if (key !== null) this.constPoolIndex.set(key, idx);
    return idx;
  }

  // Stmt visitors
  visitExpressionStmt(stmt: ExpressionStmt): void {
    this.compileNode(stmt.expression);
    this.emit(Opcode.POP);
  }

  visitPrintStmt(stmt: PrintStmt): void {
    this.compileNode(stmt.expression);
    this.emit(Opcode.PRINT);
  }

  visitVarStmt(stmt: VarStmt): void {
    this.currentLine = stmt.name.line;
    if (stmt.initializer) {
      this.compileNode(stmt.initializer);
    } else {
      this.emit(Opcode.CONST, this.addConstant(null));
    }
    if (this.isTopLevel()) {
      // Top-level variables are globals, visible inside every function (SPEC 6, D1).
      const name = stmt.name.lexeme;
      if (this.declaredGlobals.has(name)) {
        throw new SemanticError(stmt.name, "Variable with this name already declared in this scope.");
      }
      this.declaredGlobals.add(name);
      this.emit(Opcode.DEFINE_GLOBAL, this.addConstant(name));
      return;
    }
    const slot = this.declareLocal(stmt.name.lexeme);
    this.emit(Opcode.SET_LOCAL, slot);
    this.emit(Opcode.POP);
  }

  /** True outside every function body, block and try block: where a `var` declares a global. */
  private isTopLevel(): boolean {
    return this.functionDepth === 0 && this.tryDepth === 0 && this.scopeStack.length === 1;
  }
  visitBlockStmt(stmt: any): void {
    const startLocal = this.nextLocal;
    this.beginScope();
    const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
    this.openBlocks.push(enterPos);
    const statements = stmt.statements ?? [];
    for (const s of statements) {
      this.compileNode(s);
    }
    const newLocals = this.nextLocal - startLocal;
    this.patchOperand(enterPos, newLocals);
    this.emit(Opcode.EXIT_BLOCK, newLocals);
    this.openBlocks.pop();
    this.endScope(startLocal);
  }

  private beginLoop(continueTarget: number | null): LoopContext {
    const ctx: LoopContext = {
      breaks: [], continues: [], continueTarget,
      blockDepth: this.openBlocks.length, tryDepth: this.tryDepth,
    };
    this.loops.push(ctx);
    return ctx;
  }

  /** Patches pending jumps: EXIT_BLOCK sizes (the blocks have closed) and forward targets. */
  private patchPending(jumps: PendingJump[], target: number) {
    for (const j of jumps) {
      const size = j.blocks.reduce((n, pos) => n + this.chunk.code[pos + 1], 0);
      this.patchOperand(j.exitPos, size);
      if (j.jumpPos >= 0) {
        this.chunk.code[j.jumpPos + 1] = target - (j.jumpPos + 2);
      }
    }
  }

  visitBreakStmt(stmt: BreakStmt): void {
    const ctx = this.loops[this.loops.length - 1];
    if (!ctx) throw new SemanticError(stmt.keyword, `'${stmt.keyword.lexeme}' must be inside a loop.`);
    // Leave every try block and block opened inside the loop body, then jump.
    for (let i = ctx.tryDepth; i < this.tryDepth; i++) this.emit(Opcode.TRY_POP);
    const pending: PendingJump = {
      exitPos: this.emitPlaceholder(Opcode.EXIT_BLOCK),
      blocks: this.openBlocks.slice(ctx.blockDepth),
      jumpPos: -1,
    };
    if (stmt.isContinue && ctx.continueTarget !== null) {
      this.emitJump(ctx.continueTarget);
      ctx.continues.push(pending);
    } else {
      pending.jumpPos = this.emitPlaceholder(Opcode.JUMP);
      (stmt.isContinue ? ctx.continues : ctx.breaks).push(pending);
    }
  }

  visitForOfStmt(stmt: ForOfStmt): void {
    // { items = ITER_ITEMS(iterable); i = 0; x;
    //   loop: if (!(i < arrayLen(items))) goto exit; x = items[i]; body; continue: i = i + 1; goto loop
    //   exit: }
    const startLocal = this.nextLocal;
    this.beginScope();
    const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
    this.openBlocks.push(enterPos);
    this.compileNode(stmt.iterable);
    this.emit(Opcode.ITER_ITEMS);
    const items = this.declareLocal("@items"); // names no source identifier can take
    this.emit(Opcode.SET_LOCAL, items);
    this.emit(Opcode.POP);
    const index = this.declareLocal("@index");
    this.emit(Opcode.CONST, this.addConstant(0));
    this.emit(Opcode.SET_LOCAL, index);
    this.emit(Opcode.POP);
    const item = this.declareLocal(stmt.name.lexeme);

    const loopStart = this.chunk.code.length;
    this.emit(Opcode.GET_LOCAL, index);
    this.emit(Opcode.GET_LOCAL, items);
    this.emit(Opcode.HOST_CALL, this.addConstant("arrayLen"));
    this.emit(1);
    this.emit(Opcode.LESS);
    const exitJump = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    this.emit(Opcode.GET_LOCAL, items);
    this.emit(Opcode.GET_LOCAL, index);
    this.emit(Opcode.INDEX_GET, 0);
    this.emit(Opcode.SET_LOCAL, item);
    this.emit(Opcode.POP);

    const ctx = this.beginLoop(null);
    this.compileNode(stmt.body);
    this.loops.pop();

    const continueAt = this.chunk.code.length;
    // Close any closure upvalues captured from this iteration's binding before overwriting it (LANG-05).
    this.emit(Opcode.CLOSE_UPVALUE, item);
    this.emit(Opcode.GET_LOCAL, index);
    this.emit(Opcode.CONST, this.addConstant(1));
    this.emit(Opcode.ADD);
    this.emit(Opcode.SET_LOCAL, index);
    this.emit(Opcode.POP);
    this.emitJump(loopStart);
    this.patchJump(exitJump);
    const exitAt = this.chunk.code.length;

    const newLocals = this.nextLocal - startLocal;
    this.patchOperand(enterPos, newLocals);
    this.emit(Opcode.EXIT_BLOCK, newLocals);
    this.openBlocks.pop();
    this.endScope(startLocal);
    this.patchPending(ctx.continues, continueAt);
    this.patchPending(ctx.breaks, exitAt);
  }

  visitIndexExpr(expr: IndexExpr): void {
    this.compileNode(expr.object);
    this.compileNode(expr.index);
    this.emit(Opcode.INDEX_GET, expr.member ? 1 : 0);
  }

  /**
   * `a[i][j] = v` stores a copy back into the root variable (SPEC 3.3).
   * Single-step non-compound targets compile directly with zero temp locals;
   * multi-step or compound targets evaluate each key expression once into temp locals.
   * The analyzer allows this only as a statement, so it leaves nil for the POP that follows.
   */
  visitSetIndexExpr(expr: SetIndex): void {
    const steps: IndexExpr[] = [];
    let node: Expr = expr.target;
    while (node instanceof IndexExpr) {
      steps.push(node);
      node = node.object;
    }
    steps.reverse();
    const rootVar = node as Variable;

    if (steps.length === 1 && expr.operator === null) {
      this.compileNode(rootVar);
      this.compileNode(steps[0].index);
      this.compileNode(expr.value);
      this.emit(Opcode.INDEX_SET, steps[0].member ? 1 : 0);
      this.storeVariable(rootVar);
      this.emit(Opcode.CONST, this.addConstant(null));
      return;
    }

    const startLocal = this.nextLocal;
    this.beginScope();
    const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
    this.openBlocks.push(enterPos);

    // Evaluate every key expression once left-to-right.
    const emitKeys: (() => void)[] = steps.map((step, i) => {
      if (step.index instanceof Literal) {
        const val = step.index.value;
        return () => this.emit(Opcode.CONST, this.addConstant(val));
      }
      this.compileNode(step.index);
      const slot = this.declareLocal(`@k${i}`);
      this.emit(Opcode.SET_LOCAL, slot);
      this.emit(Opcode.POP);
      return () => this.emit(Opcode.GET_LOCAL, slot);
    });

    // Compute the leaf value (reading existing leaf first if compound).
    if (expr.operator !== null) {
      this.compileNode(rootVar);
      for (let i = 0; i < steps.length; i++) {
        emitKeys[i]();
        this.emit(Opcode.INDEX_GET, steps[i].member ? 1 : 0);
      }
      this.compileNode(expr.value);
      this.emitBinaryOpcode(expr.operator);
    } else {
      this.compileNode(expr.value);
    }
    const valSlot = this.declareLocal("@val");
    this.emit(Opcode.SET_LOCAL, valSlot);
    this.emit(Opcode.POP);

    // Rebuild updated copies from leaf back to root, storing into root BEFORE closing temp locals.
    const rebuildFrom = (depth: number): void => {
      if (depth === steps.length) {
        this.emit(Opcode.GET_LOCAL, valSlot);
        return;
      }
      this.compileNode(rootVar);
      for (let j = 0; j < depth; j++) {
        emitKeys[j]();
        this.emit(Opcode.INDEX_GET, steps[j].member ? 1 : 0);
      }
      emitKeys[depth]();
      rebuildFrom(depth + 1);
      this.emit(Opcode.INDEX_SET, steps[depth].member ? 1 : 0);
    };
    rebuildFrom(0);
    this.storeVariable(rootVar);

    const newLocals = this.nextLocal - startLocal;
    this.patchOperand(enterPos, newLocals);
    this.emit(Opcode.EXIT_BLOCK, newLocals);
    this.openBlocks.pop();
    this.endScope(startLocal);

    this.emit(Opcode.CONST, this.addConstant(null));
  }

  private emitBinaryOpcode(operator: { type: TokenType; lexeme: string }): void {
    switch (operator.type) {
      case TokenType.PLUS: this.emit(Opcode.ADD); break;
      case TokenType.MINUS: this.emit(Opcode.SUB); break;
      case TokenType.STAR: this.emit(Opcode.MUL); break;
      case TokenType.SLASH: this.emit(Opcode.DIV); break;
      case TokenType.PERCENT: this.emit(Opcode.MOD); break;
      default: throw new Error(`Unsupported compound operator ${operator.lexeme}`);
    }
  }

  /** Stores top-of-stack into `target` variable and leaves the stack clean (0 extra values). */
  private storeVariable(target: Variable): void {
    const local = this.resolveLocal(target.name.lexeme);
    if (local !== undefined) {
      this.emit(Opcode.SET_LOCAL, local);
      this.emit(Opcode.POP);
      return;
    }
    const uv = this.resolveUpvalue(this.frames.length - 1, target.name.lexeme);
    if (uv !== undefined) {
      this.emit(Opcode.SET_UPVALUE, uv);
      this.emit(Opcode.POP);
      return;
    }
    if (!this.globalNames.has(target.name.lexeme)) {
      throw new SemanticError(target.name, "Cannot assign to undefined variable.");
    }
    this.emit(Opcode.SET_GLOBAL, this.addConstant(target.name.lexeme));
  }
  visitIfStmt(stmt: IfStmt): void {
    this.compileNode(stmt.condition);
    const jumpIfFalsePos = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    this.compileNode(stmt.thenBranch);
    const jumpPos = this.emitPlaceholder(Opcode.JUMP);
    this.patchJump(jumpIfFalsePos);
    if (stmt.elseBranch) {
      this.compileNode(stmt.elseBranch);
    }
    this.patchJump(jumpPos);
  }
  visitWhileStmt(stmt: WhileStmt): void {
    const loopStart = this.chunk.code.length;
    this.compileNode(stmt.condition);
    const exitJump = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    const ctx = this.beginLoop(loopStart);
    this.compileNode(stmt.body);
    this.loops.pop();
    this.emitJump(loopStart);
    this.patchJump(exitJump);
    this.patchPending(ctx.continues, loopStart);
    this.patchPending(ctx.breaks, this.chunk.code.length);
  }
  visitForStmt(stmt: ForStmt): void {
    // For loops are compiled as: initializer; while(condition) { body; increment; }
    const startLocal = this.nextLocal;
    this.beginScope();
    const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
    this.openBlocks.push(enterPos);

    // 1. Execute initializer (if present)
    if (stmt.initializer !== null) {
      this.compileNode(stmt.initializer);
    }

    // 2. Loop start - evaluate condition
    const loopStart = this.chunk.code.length;
    let exitJump = -1;
    if (stmt.condition !== null) {
      this.compileNode(stmt.condition);
      exitJump = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    }

    // 3. Execute body
    const ctx = this.beginLoop(null);
    this.compileNode(stmt.body);
    this.loops.pop();

    // 4. Execute increment (if present); `continue` lands here
    const continueAt = this.chunk.code.length;
    if (stmt.increment !== null) {
      this.compileNode(stmt.increment);
      this.emit(Opcode.POP); // discard increment expression result
    }

    // 5. Jump back to condition check
    this.emitJump(loopStart);

    // 6. Patch exit jump (if condition exists); `break` lands here too
    if (exitJump !== -1) {
      this.patchJump(exitJump);
    }
    const exitAt = this.chunk.code.length;

    // Clean up block scope
    const newLocals = this.nextLocal - startLocal;
    this.patchOperand(enterPos, newLocals);
    this.emit(Opcode.EXIT_BLOCK, newLocals);
    this.openBlocks.pop();
    this.endScope(startLocal);
    this.patchPending(ctx.continues, continueAt);
    this.patchPending(ctx.breaks, exitAt);
  }
  private compileFunction(name: string, params: Token[], body: Stmt[], selfName: string | null): FunctionEntry {
    const jumpOver = this.emitPlaceholder(Opcode.JUMP);
    const fnAddr = this.chunk.code.length;
    const isTopLevelNamed = this.frames.length === 1 && this.scopeStack.length === 1 && this.tryDepth === 0 && name !== "" && selfName === null;
    if (isTopLevelNamed) {
      this.functions.set(name, { name, address: fnAddr, arity: params.length, locals: 0 });
    }
    this.frames.push(makeFrame());
    for (const p of params) {
      this.declareLocal(p.lexeme);
    }
    let selfSlot: number | undefined;
    if (selfName !== null && !params.some((p) => p.lexeme === selfName)) {
      selfSlot = this.declareLocal(selfName);
    }
    for (const st of body) {
      this.compileNode(st);
    }
    this.emit(Opcode.CONST, this.addConstant(null));
    this.emit(Opcode.RETURN);
    const compiled = this.frames.pop()!;
    const entry: FunctionEntry = {
      name,
      address: fnAddr,
      arity: params.length,
      locals: compiled.nextLocal,
    };
    if (compiled.upvalues.length > 0) entry.upvalues = compiled.upvalues;
    if (selfSlot !== undefined) entry.selfSlot = selfSlot;
    if (this.emitDebug && compiled.localNames.length > 0) entry.localNames = compiled.localNames;
    if (isTopLevelNamed) {
      this.functions.set(name, entry);
    }
    this.chunk.functions?.push(entry);
    this.patchJump(jumpOver);
    return entry;
  }

  visitFunctionStmt(stmt: FunctionStmt): void {
    const isTop = this.frames.length === 1 && this.scopeStack.length === 1 && this.tryDepth === 0;
    if (isTop) {
      this.compileFunction(stmt.name.lexeme, stmt.params, stmt.body, null);
      return;
    }
    const slot = this.declareLocal(stmt.name.lexeme);
    const entry = this.compileFunction(stmt.name.lexeme, stmt.params, stmt.body, null);
    this.emit(Opcode.CLOSURE, entry.address);
    this.emit(Opcode.SET_LOCAL, slot);
    this.emit(Opcode.POP);
  }
  visitReturnStmt(stmt: ReturnStmt): void {
    if (stmt.value) {
      this.compileNode(stmt.value);
    } else {
      this.emit(Opcode.CONST, this.addConstant(null));
    }
    this.emit(Opcode.RETURN);
  }
  visitTryCatchStmt(stmt: TryCatchStmt): void {
    // Layout:
    // TRY_PUSH <catchOffset>   - register exception handler
    // <try block statements>
    // TRY_POP                  - remove handler if no exception
    // JUMP <afterCatch>        - skip catch block
    // <catch block>            - handler entry point (error value on stack)
    // <statements>

    // Emit TRY_PUSH with placeholder offset to catch block
    const tryPushPos = this.emitPlaceholder(Opcode.TRY_PUSH);

    // Compile try block in a block scope so `var` inside `try` stays local and cleans up properly.
    const tryStartLocal = this.nextLocal;
    this.beginScope();
    const tryEnterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
    this.openBlocks.push(tryEnterPos);
    this.tryDepth++;
    for (const s of stmt.tryBlock) {
      this.compileNode(s);
    }
    this.tryDepth--;
    const tryLocals = this.nextLocal - tryStartLocal;
    this.patchOperand(tryEnterPos, tryLocals);
    this.emit(Opcode.EXIT_BLOCK, tryLocals);
    this.openBlocks.pop();
    this.endScope(tryStartLocal);

    // Pop exception handler (no exception occurred)
    this.emit(Opcode.TRY_POP);

    // Jump over catch block
    const jumpOverCatch = this.emitPlaceholder(Opcode.JUMP);

    // Patch TRY_PUSH offset - catch block starts here
    this.patchJump(tryPushPos);

    // Catch block - error value is on stack at base + startLocal when entered from handleException.
    if (stmt.catchParam) {
      const startLocal = this.nextLocal;
      this.beginScope();
      // Claim the error value pushed by handleException as slot `startLocal` directly.
      const paramEnterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
      this.patchOperand(paramEnterPos, 1);
      this.openBlocks.push(paramEnterPos);
      this.declareLocal(stmt.catchParam);

      // Reserve any locals declared inside the catch body above the catch parameter slot.
      const bodyStartLocal = this.nextLocal;
      const bodyEnterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
      this.openBlocks.push(bodyEnterPos);
      for (const s of stmt.catchBlock) {
        this.compileNode(s);
      }
      const bodyLocals = this.nextLocal - bodyStartLocal;
      this.patchOperand(bodyEnterPos, bodyLocals);
      this.emit(Opcode.EXIT_BLOCK, bodyLocals + 1);
      this.openBlocks.pop();
      this.openBlocks.pop();
      this.endScope(startLocal);
    } else {
      // No catch parameter - pop the error from stack, then compile catch block in its own scope.
      this.emit(Opcode.POP);
      const startLocal = this.nextLocal;
      this.beginScope();
      const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
      this.openBlocks.push(enterPos);
      for (const s of stmt.catchBlock) {
        this.compileNode(s);
      }
      const newLocals = this.nextLocal - startLocal;
      this.patchOperand(enterPos, newLocals);
      this.emit(Opcode.EXIT_BLOCK, newLocals);
      this.openBlocks.pop();
      this.endScope(startLocal);
    }

    // Patch jump to skip catch block
    this.patchJump(jumpOverCatch);
  }

  // Expr visitors
  visitLiteralExpr(expr: Literal): void {
    const idx = this.addConstant(expr.value);
    this.emit(Opcode.CONST, idx);
  }

  private evalConstLiteral(expr: Expr): { ok: true; value: any } | { ok: false } {
    if (expr instanceof Literal) return { ok: true, value: expr.value };
    if (expr instanceof Grouping) return this.evalConstLiteral(expr.expression);
    if (expr instanceof Unary) {
      const r = this.evalConstLiteral(expr.right);
      if (!r.ok) return { ok: false };
      if (expr.operator.type === TokenType.BANG) {
        return { ok: true, value: r.value !== false && r.value !== null && r.value !== undefined ? false : true };
      }
      if (expr.operator.type === TokenType.MINUS && typeof r.value === "number" && Number.isFinite(r.value)) {
        return { ok: true, value: r.value === 0 ? 0 : -r.value };
      }
      return { ok: false };
    }
    if (expr instanceof Binary) {
      const l = this.evalConstLiteral(expr.left);
      if (!l.ok) return { ok: false };
      const r = this.evalConstLiteral(expr.right);
      if (!r.ok) return { ok: false };
      const lv = l.value;
      const rv = r.value;
      switch (expr.operator.type) {
        case TokenType.PLUS:
          if (typeof lv === "number" && typeof rv === "number") {
            const sum = lv + rv;
            return Number.isFinite(sum) ? { ok: true, value: sum } : { ok: false };
          }
          if (typeof lv === "string" && typeof rv === "string" && lv.length + rv.length <= 1024) {
            return { ok: true, value: lv + rv };
          }
          return { ok: false };
        case TokenType.MINUS:
        case TokenType.STAR:
          if (typeof lv === "number" && typeof rv === "number") {
            const res = expr.operator.type === TokenType.MINUS ? lv - rv : lv * rv;
            return Number.isFinite(res) ? { ok: true, value: res } : { ok: false };
          }
          return { ok: false };
        case TokenType.SLASH:
        case TokenType.PERCENT:
          if (typeof lv === "number" && typeof rv === "number" && rv !== 0) {
            const res = expr.operator.type === TokenType.SLASH ? lv / rv : lv % rv;
            return Number.isFinite(res) ? { ok: true, value: res } : { ok: false };
          }
          return { ok: false };
        case TokenType.LESS:
        case TokenType.LESS_EQUAL:
        case TokenType.GREATER:
        case TokenType.GREATER_EQUAL:
          if (typeof lv === "number" && typeof rv === "number" && !Number.isNaN(lv) && !Number.isNaN(rv)) {
            if (expr.operator.type === TokenType.LESS) return { ok: true, value: lv < rv };
            if (expr.operator.type === TokenType.LESS_EQUAL) return { ok: true, value: lv <= rv };
            if (expr.operator.type === TokenType.GREATER) return { ok: true, value: lv > rv };
            return { ok: true, value: lv >= rv };
          }
          if (typeof lv === "string" && typeof rv === "string") {
            const cmp = compareStringsByCodePoint(lv, rv);
            if (expr.operator.type === TokenType.LESS) return { ok: true, value: cmp < 0 };
            if (expr.operator.type === TokenType.LESS_EQUAL) return { ok: true, value: cmp <= 0 };
            if (expr.operator.type === TokenType.GREATER) return { ok: true, value: cmp > 0 };
            return { ok: true, value: cmp >= 0 };
          }
          return { ok: false };
        case TokenType.EQUAL_EQUAL:
          return { ok: true, value: lv === rv };
        case TokenType.BANG_EQUAL:
          return { ok: true, value: lv !== rv };
      }
    }
    return { ok: false };
  }

  visitGroupingExpr(expr: Grouping): void {
    this.compileNode(expr.expression);
  }

  visitUnaryExpr(expr: Unary): void {
    const folded = this.evalConstLiteral(expr);
    if (folded.ok) {
      this.emit(Opcode.CONST, this.addConstant(folded.value));
      return;
    }
    this.compileNode(expr.right);
    switch (expr.operator.type) {
      case TokenType.MINUS:
        this.emit(Opcode.NEG);
        break;
      case TokenType.BANG:
        this.emit(Opcode.NOT);
        break;
      default:
        throw new Error(`Unsupported unary operator ${expr.operator.lexeme}`);
    }
  }

  visitBinaryExpr(expr: Binary): void {
    const folded = this.evalConstLiteral(expr);
    if (folded.ok) {
      this.emit(Opcode.CONST, this.addConstant(folded.value));
      return;
    }
    switch (expr.operator.type) {
      case TokenType.AND:
        this.emitLogicalAnd(expr);
        break;
      case TokenType.OR:
        this.emitLogicalOr(expr);
        break;
      default:
        this.compileNode(expr.left);
        this.compileNode(expr.right);
        switch (expr.operator.type) {
          case TokenType.PLUS:
            this.emit(Opcode.ADD);
            break;
          case TokenType.MINUS:
            this.emit(Opcode.SUB);
            break;
          case TokenType.STAR:
            this.emit(Opcode.MUL);
            break;
          case TokenType.SLASH:
            this.emit(Opcode.DIV);
            break;
          case TokenType.PERCENT:
            this.emit(Opcode.MOD);
            break;
          default:
            switch (expr.operator.type) {
              case TokenType.EQUAL_EQUAL:
                this.emit(Opcode.EQUAL);
                break;
              case TokenType.BANG_EQUAL:
                this.emit(Opcode.NOT_EQUAL);
                break;
              case TokenType.GREATER:
                this.emit(Opcode.GREATER);
                break;
              case TokenType.GREATER_EQUAL:
                this.emit(Opcode.GREATER_EQUAL);
                break;
              case TokenType.LESS:
                this.emit(Opcode.LESS);
                break;
              case TokenType.LESS_EQUAL:
                this.emit(Opcode.LESS_EQUAL);
                break;
              default:
                throw new Error(`Unsupported binary operator ${expr.operator.lexeme}`);
            }
        }
    }
  }

  visitVariableExpr(expr: Variable): void {
    const local = this.resolveLocal(expr.name.lexeme);
    if (local !== undefined) {
      this.emit(Opcode.GET_LOCAL, local);
      return;
    }
    const uv = this.resolveUpvalue(this.frames.length - 1, expr.name.lexeme);
    if (uv !== undefined) {
      this.emit(Opcode.GET_UPVALUE, uv);
      return;
    }
    if (!this.globalNames.has(expr.name.lexeme)) {
      // A top-level function used as a value (SPEC 3.1): push a reference to it.
      const fn = this.functions.get(expr.name.lexeme);
      if (fn) {
        this.emit(Opcode.FUNC, fn.address);
        return;
      }
      if (this.hoisted.has(expr.name.lexeme)) {
        this.emit(Opcode.FUNC, 0);
        this.callFixups.push({ operandPos: this.chunk.code.length - 1, name: expr.name.lexeme });
        return;
      }
      throw new SemanticError(expr.name, "Variable is not defined.");
    }
    const nameIdx = this.addConstant(expr.name.lexeme);
    this.emit(Opcode.GET_GLOBAL, nameIdx);
  }
  visitAssignExpr(expr: Assign): void {
    this.compileNode(expr.value);
    const local = this.resolveLocal(expr.name.lexeme);
    if (local !== undefined) {
      // OpSetLocal leaves the assigned value on top of the stack.
      this.emit(Opcode.SET_LOCAL, local);
      return;
    }
    const uv = this.resolveUpvalue(this.frames.length - 1, expr.name.lexeme);
    if (uv !== undefined) {
      // OpSetUpvalue leaves the assigned value on top of the stack.
      this.emit(Opcode.SET_UPVALUE, uv);
      return;
    }
    if (!this.globalNames.has(expr.name.lexeme)) {
      // Assigning an undeclared name is an error, not an implicit global (SPEC 4.5, D3).
      throw new SemanticError(expr.name, "Cannot assign to undefined variable.");
    }
    const nameIdx = this.addConstant(expr.name.lexeme);
    this.emit(Opcode.SET_GLOBAL, nameIdx);
    // Leave the assigned value on the stack to support expression contexts
    this.emit(Opcode.GET_GLOBAL, nameIdx);
  }

  visitTernaryExpr(expr: TernaryExpr): void {
    this.compileNode(expr.condition);
    const toElse = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    this.compileNode(expr.thenBranch);
    const toEnd = this.emitPlaceholder(Opcode.JUMP);
    this.patchJump(toElse);
    this.compileNode(expr.elseBranch);
    this.patchJump(toEnd);
  }

  visitTemplateLiteralExpr(expr: TemplateLiteralExpr): void {
    const parts = expr.parts;
    if (parts.length === 0) {
      this.emit(Opcode.CONST, this.addConstant(""));
      return;
    }
    if (parts.length === 1) {
      if (parts[0] instanceof Literal && typeof parts[0].value === "string") {
        this.emit(Opcode.CONST, this.addConstant(parts[0].value));
      } else {
        this.emit(Opcode.CONST, this.addConstant(""));
        this.compileNode(parts[0]);
        this.emit(Opcode.ADD);
      }
      return;
    }
    // Emit left-to-right; keep an empty leading literal if the second part may not be a string.
    let emitted = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part instanceof Literal && part.value === "" && emitted >= 2) {
        continue;
      }
      if (i === 0 && part instanceof Literal && part.value === "" && parts.length >= 2 && parts[1] instanceof Literal && typeof parts[1].value === "string") {
        continue;
      }
      this.compileNode(part);
      emitted++;
      if (emitted > 1) {
        this.emit(Opcode.ADD);
      }
    }
    if (emitted === 0) {
      this.emit(Opcode.CONST, this.addConstant(""));
    }
  }

  visitFunctionExpr(expr: FunctionExpr): void {
    const entry = this.compileFunction(expr.name?.lexeme ?? "", expr.params, expr.body, expr.name?.lexeme ?? null);
    this.emit(Opcode.CLOSURE, entry.address);
  }

  visitCallExpr(expr: any): void {
    // A function value: from an expression, or a variable/upvalue that holds one (SPEC 4.6).
    if (!(expr.callee instanceof Variable)
      || this.resolveLocal(expr.callee.name.lexeme) !== undefined
      || this.resolveUpvalue(this.frames.length - 1, expr.callee.name.lexeme) !== undefined
      || this.globalNames.has(expr.callee.name.lexeme)) {
      this.compileNode(expr.callee);
      for (const arg of expr.arguments) {
        this.compileNode(arg);
      }
      this.emit(Opcode.CALL_VALUE, expr.arguments.length);
      return;
    }
    const calleeName = expr.callee.name.lexeme;
    // Direct event/scheduler built-ins compile to dedicated VM opcodes (LANG-10).
    if (!this.functions.has(calleeName) && !this.hoisted.has(calleeName)) {
      if (calleeName === "yield" && expr.arguments.length === 0) {
        this.emit(Opcode.YIELD);
        this.emit(Opcode.CONST, this.addConstant(null));
        return;
      }
      if (calleeName === "sleep" && expr.arguments.length === 1) {
        this.compileNode(expr.arguments[0]);
        this.emit(Opcode.SLEEP);
        this.emit(Opcode.CONST, this.addConstant(null));
        return;
      }
      if (calleeName === "emit" && (expr.arguments.length === 1 || expr.arguments.length === 2)) {
        this.emit(Opcode.CONST, this.addConstant("name"));
        this.compileNode(expr.arguments[0]);
        this.emit(Opcode.CONST, this.addConstant("payload"));
        if (expr.arguments.length === 2) {
          this.compileNode(expr.arguments[1]);
        } else {
          this.emit(Opcode.CONST, this.addConstant(null));
        }
        this.emit(Opcode.NEW_OBJECT, 2);
        this.emit(Opcode.EMIT_EVENT);
        this.emit(Opcode.POP);
        this.emit(Opcode.CONST, this.addConstant(null));
        return;
      }
      if (calleeName === "pollEvent" && expr.arguments.length === 0) {
        this.emit(Opcode.POLL_EVENT);
        return;
      }
    }
    // evaluate args
    for (const arg of expr.arguments) {
      this.compileNode(arg);
    }
    const fn = this.functions.get(calleeName);
    if (fn) {
      this.emit(Opcode.CALL, fn.address);
      this.emit(expr.arguments.length);
      return;
    }
    if (this.hoisted.has(calleeName)) {
      // Declared later in the file: emit the call now, patch the address once it is compiled.
      this.emit(Opcode.CALL, 0);
      this.callFixups.push({ operandPos: this.chunk.code.length - 1, name: calleeName });
      this.emit(expr.arguments.length);
      return;
    }
    // Anything else must be a registered built-in or host call (hostapi.json). An unknown name
    // is a compile-time error, never a HOST_CALL that fails at runtime (SPEC 4.6, D3).
    const host = lookupHostFunction(calleeName);
    if (!host) {
      throw new SemanticError(expr.callee.name, `Unknown function '${calleeName}'.`);
    }
    const arity = arityError(host, expr.arguments.length);
    if (arity) throw new SemanticError(expr.paren, arity);
    const nameIdx = this.addConstant(calleeName);
    this.emit(Opcode.HOST_CALL, nameIdx);
    this.emit(expr.arguments.length);
  }
  visitImportStmt(stmt: ImportStmt): void {
    throw new SemanticError(stmt.keyword, "Imports must be resolved by the module linker before compilation.");
  }

  visitExportStmt(stmt: ExportStmt): void {
    if (stmt.declaration) {
      this.compileNode(stmt.declaration);
    }
  }

  visitErrorExpr(): void { throw new Error("Error expr not supported in bytecode yet"); }

  visitArrayExpr(expr: ArrayExpr): void {
    // Compile each element expression - pushes values onto stack
    for (const element of expr.elements) {
      this.compileNode(element);
    }
    // Emit NEW_ARRAY with element count to create array from stack
    this.emit(Opcode.NEW_ARRAY, expr.elements.length);
  }

  visitObjectExpr(expr: ObjectExpr): void {
    // Push key-value pairs onto stack: key1, value1, key2, value2, ...
    for (const prop of expr.properties) {
      // Push key as string constant
      this.emit(Opcode.CONST, this.addConstant(prop.key));
      // Compile value expression
      this.compileNode(prop.value);
    }
    // Emit NEW_OBJECT with property count
    this.emit(Opcode.NEW_OBJECT, expr.properties.length);
  }

  private emitPlaceholder(op: Opcode): number {
    const pos = this.chunk.code.length;
    this.emit(op, 0); // placeholder operand, patched later; keeps lineMap aligned with code (D18)
    return pos;
  }

  private patchOperand(pos: number, operand: number) {
    this.chunk.code[pos + 1] = operand;
  }

  private patchJump(pos: number) {
    // pos points to opcode, operand is at pos+1
    const offset = this.chunk.code.length - (pos + 2);
    this.chunk.code[pos + 1] = offset;
  }

  private declareLocal(name: string): number {
    const currentScope = this.scopeStack[this.scopeStack.length - 1];
    if (currentScope.has(name)) {
      throw new Error(`Local '${name}' already declared`);
    }
    const slot = this.nextLocal;
    currentScope.set(name, slot);
    if (this.emitDebug) {
      this.frame.localNames[slot] = name;
    }
    this.nextLocal++;
    return slot;
  }

  private resolveLocal(name: string): number | undefined {
    return BytecodeCompiler.resolveLocalInScopes(this.scopeStack, name);
  }

  private static resolveLocalInScopes(scopes: Map<string, number>[], name: string): number | undefined {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i];
      if (scope.has(name)) {
        return scope.get(name);
      }
    }
    return undefined;
  }

  private resolveUpvalue(frameIdx: number, name: string): number | undefined {
    if (frameIdx <= 0) return undefined;
    const parent = this.frames[frameIdx - 1];
    const localSlot = BytecodeCompiler.resolveLocalInScopes(parent.scopeStack, name);
    if (localSlot !== undefined) {
      return this.addUpvalue(frameIdx, true, localSlot);
    }
    const parentUv = this.resolveUpvalue(frameIdx - 1, name);
    if (parentUv !== undefined) {
      return this.addUpvalue(frameIdx, false, parentUv);
    }
    return undefined;
  }

  private addUpvalue(frameIdx: number, isLocal: boolean, index: number): number {
    const uvs = this.frames[frameIdx].upvalues;
    for (let i = 0; i < uvs.length; i++) {
      if (uvs[i].isLocal === isLocal && uvs[i].index === index) {
        return i;
      }
    }
    uvs.push({ isLocal, index });
    return uvs.length - 1;
  }

  private beginScope() {
    this.scopeStack.push(new Map());
  }

  private endScope(startLocal: number) {
    this.scopeStack.pop();
    this.nextLocal = startLocal;
  }

  // `a && b` and `a || b` short-circuit and always produce a boolean (SPEC 4.4, D16).
  // The VM's JUMP_IF_FALSE pops its condition, so the result is rebuilt on each path:
  //   a && b:  a; JIF Lfalse; b; NOT; NOT; JUMP Lend; Lfalse: CONST false; Lend:
  //   a || b:  a; JIF Lright; CONST true; JUMP Lend; Lright: b; NOT; NOT; Lend:
  private emitLogicalAnd(expr: Binary) {
    this.compileNode(expr.left);
    const toFalse = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    this.compileNode(expr.right);
    this.emit(Opcode.NOT);
    this.emit(Opcode.NOT);
    const toEnd = this.emitPlaceholder(Opcode.JUMP);
    this.patchJump(toFalse);
    this.emit(Opcode.CONST, this.addConstant(false));
    this.patchJump(toEnd);
  }

  private emitLogicalOr(expr: Binary) {
    this.compileNode(expr.left);
    const toRight = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    this.emit(Opcode.CONST, this.addConstant(true));
    const toEnd = this.emitPlaceholder(Opcode.JUMP);
    this.patchJump(toRight);
    this.compileNode(expr.right);
    this.emit(Opcode.NOT);
    this.emit(Opcode.NOT);
    this.patchJump(toEnd);
  }
}

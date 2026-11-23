import { Opcode, type Chunk } from "./Bytecode";
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
import { VarStmt } from "./classes/VarStmt";
import { Variable } from "./classes/Variable";
import { Assign } from "./classes/Assign";
import { IfStmt } from "./classes/IfStmt";
import { WhileStmt } from "./classes/WhileStmt";
import { ForStmt } from "./classes/ForStmt";
import { ReturnStmt } from "./classes/ReturnStmt";
import { FunctionStmt } from "./classes/FunctionStmt";
import { SemanticError } from "./SemanticAnalyzer";
import { arityError, lookupHostFunction } from "./HostApi";
import { TryCatchStmt } from "./classes/TryCatchStmt";
import { ArrayExpr } from "./classes/ArrayExpr";
import { ObjectExpr } from "./classes/ObjectExpr";
import type { FunctionEntry } from "./Bytecode";
import { IndexExpr } from "./classes/IndexExpr";
import type { SetIndex } from "./classes/SetIndex";
import type { BreakStmt } from "./classes/BreakStmt";
import type { ForOfStmt } from "./classes/ForOfStmt";

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

/**
 * Very small bytecode compiler that covers literals, unary/binary ops, and print/expr statements.
 * This is a starting point for the Go VM pipeline.
 */
export class BytecodeCompiler implements ExprVisitor<void>, StmtVisitor<void> {
  chunk: Chunk = { constants: [], code: [], functions: [], lineMap: [] };
  scopeStack: Map<string, number>[] = [new Map()];
  nextLocal = 0;
  functions: Map<string, FunctionEntry> = new Map();
  /** Top-level function names, collected before code generation so calls can precede declarations (D2). */
  hoisted: Set<string> = new Set();
  /** CALL operands emitted before their callee was compiled; patched in compile(). */
  callFixups: { operandPos: number; name: string }[] = [];
  /** Every top-level `var` name in the file, collected up front: these are the globals (SPEC 6, D1). */
  globalNames: Set<string> = new Set();
  /** Globals declared so far, to reject a second top-level `var` of the same name. */
  declaredGlobals: Set<string> = new Set();
  /** Nesting depth of function bodies and try blocks being compiled. */
  functionDepth = 0;
  tryDepth = 0;
  currentLine = 1; // Track current source line for error mapping
  /** Loops being compiled in the current function, innermost last. */
  loops: LoopContext[] = [];
  /** ENTER_BLOCK positions of the blocks open at the current point, innermost last. */
  openBlocks: number[] = [];

  static compile(statements: Stmt[]): Chunk {
    const compiler = new BytecodeCompiler();
    compiler.compile(statements);
    return compiler.chunk;
  }

  compile(statements: Stmt[]): void {
    // Hoist: every top-level function is callable from anywhere in the file (SPEC 4.6, D2).
    for (const stmt of statements) {
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

  /**
   * Compiles one node with currentLine set to that node's source line, then restores the
   * enclosing node's line, so every instruction maps to the line of the node that emitted it
   * (SPEC §10, D18). Statements and literals carry the line the parser recorded; other
   * expressions use their operator, keyword or name token.
   */
  private compileNode(node: any): void {
    const saved = this.currentLine;
    const line = BytecodeCompiler.lineOf(node);
    if (line > 0) this.currentLine = line;
    try {
      node.accept(this);
    } finally {
      this.currentLine = saved;
    }
  }

  private static lineOf(node: any): number {
    return node?.line ?? node?.operator?.line ?? node?.keyword?.line ?? node?.name?.line ?? node?.callee?.name?.line ?? node?.paren?.line ?? 0;
  }

  private emit(op: Opcode, operand?: number) {
    this.chunk.code.push(op);
    this.chunk.lineMap!.push(this.currentLine);
    if (operand !== undefined) {
      this.chunk.code.push(operand);
      this.chunk.lineMap!.push(this.currentLine);
    }
  }

  private emitJump(target: number) {
    const offset = target - (this.chunk.code.length + 2);
    this.emit(Opcode.JUMP, offset);
  }

  private addConstant(value: any): number {
    const idx = this.chunk.constants.length;
    this.chunk.constants.push(value);
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
    const index = this.declareLocal("@index");
    this.emit(Opcode.CONST, this.addConstant(0));
    this.emit(Opcode.SET_LOCAL, index);
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

    const ctx = this.beginLoop(null);
    this.compileNode(stmt.body);
    this.loops.pop();

    const continueAt = this.chunk.code.length;
    this.emit(Opcode.GET_LOCAL, index);
    this.emit(Opcode.CONST, this.addConstant(1));
    this.emit(Opcode.ADD);
    this.emit(Opcode.SET_LOCAL, index);
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
   * `a[i][j] = v` stores a copy back into the root variable (SPEC 3.3):
   *   a i  a i INDEX_GET  j  v INDEX_SET  INDEX_SET  SET a
   * The analyzer allows this only as a statement, so it leaves nil for the POP that follows.
   */
  visitSetIndexExpr(expr: SetIndex): void {
    this.emitStore(expr.target, () => this.compileNode(expr.value));
    this.emit(Opcode.CONST, this.addConstant(null));
  }

  /** Stores the value `emitValue` pushes into `target` (a variable or an element of one). */
  private emitStore(target: Expr, emitValue: () => void): void {
    if (target instanceof Variable) {
      emitValue();
      const local = this.resolveLocal(target.name.lexeme);
      if (local !== undefined) {
        this.emit(Opcode.SET_LOCAL, local);
      } else {
        if (!this.globalNames.has(target.name.lexeme)) {
          throw new SemanticError(target.name, "Cannot assign to undefined variable.");
        }
        this.emit(Opcode.SET_GLOBAL, this.addConstant(target.name.lexeme));
      }
      return;
    }
    if (!(target instanceof IndexExpr)) {
      throw new Error("internal: invalid assignment target");
    }
    const element = target;
    this.emitStore(element.object, () => {
      this.compileNode(element.object);
      this.compileNode(element.index);
      emitValue();
      this.emit(Opcode.INDEX_SET, element.member ? 1 : 0);
    });
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
  visitFunctionStmt(stmt: FunctionStmt): void {
    // Emit jump over function body so main code skips execution.
    const jumpOver = this.emitPlaceholder(Opcode.JUMP);
    const fnAddr = this.chunk.code.length;
    this.functions.set(stmt.name.lexeme, { name: stmt.name.lexeme, address: fnAddr, arity: stmt.params.length, locals: 0 });
    // Save locals state
    const prevScopes = this.scopeStack;
    const prevNextLocal = this.nextLocal;
    const prevLoops = this.loops;
    const prevBlocks = this.openBlocks;
    const prevTryDepth = this.tryDepth;
    this.scopeStack = [new Map()];
    this.nextLocal = 0;
    this.loops = [];
    this.openBlocks = [];
    this.tryDepth = 0;
    // Declare params as locals
    for (const p of stmt.params) {
      this.declareLocal(p.lexeme);
    }
    // Compile body
    this.functionDepth++;
    for (const st of stmt.body) {
      this.compileNode(st);
    }
    this.functionDepth--;
    // Ensure return nil
    this.emit(Opcode.CONST, this.addConstant(null));
    this.emit(Opcode.RETURN);
    const localCount = this.nextLocal;
    this.functions.set(stmt.name.lexeme, { name: stmt.name.lexeme, address: fnAddr, arity: stmt.params.length, locals: localCount });
    this.chunk.functions?.push({ name: stmt.name.lexeme, address: fnAddr, arity: stmt.params.length, locals: localCount });
    // Restore locals
    this.scopeStack = prevScopes;
    this.nextLocal = prevNextLocal;
    this.loops = prevLoops;
    this.openBlocks = prevBlocks;
    this.tryDepth = prevTryDepth;
    // Patch jump over function body
    this.patchJump(jumpOver);
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

    // Compile try block (a `var` here stays local, not global)
    this.tryDepth++;
    for (const s of stmt.tryBlock) {
      this.compileNode(s);
    }
    this.tryDepth--;

    // Pop exception handler (no exception occurred)
    this.emit(Opcode.TRY_POP);

    // Jump over catch block
    const jumpOverCatch = this.emitPlaceholder(Opcode.JUMP);

    // Patch TRY_PUSH offset - catch block starts here
    this.patchJump(tryPushPos);

    // Catch block - error value is on stack when entered from exception
    // If there's a catch parameter, store it as a local
    if (stmt.catchParam) {
      const startLocal = this.nextLocal;
      this.beginScope();
      const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
      this.openBlocks.push(enterPos);
      const slot = this.declareLocal(stmt.catchParam);
      this.emit(Opcode.SET_LOCAL, slot); // store error from stack
      this.emit(Opcode.POP); // clean up the SET_LOCAL push

      // Compile catch block
      for (const s of stmt.catchBlock) {
        this.compileNode(s);
      }

      const newLocals = this.nextLocal - startLocal;
      this.patchOperand(enterPos, newLocals);
      this.emit(Opcode.EXIT_BLOCK, newLocals);
      this.openBlocks.pop();
      this.endScope(startLocal);
    } else {
      // No catch parameter - just pop the error from stack
      this.emit(Opcode.POP);

      // Compile catch block
      for (const s of stmt.catchBlock) {
        this.compileNode(s);
      }
    }

    // Patch jump to skip catch block
    this.patchJump(jumpOverCatch);
  }

  // Expr visitors
  visitLiteralExpr(expr: Literal): void {
    const idx = this.addConstant(expr.value);
    this.emit(Opcode.CONST, idx);
  }

  visitGroupingExpr(expr: Grouping): void {
    this.compileNode(expr.expression);
  }

  visitUnaryExpr(expr: Unary): void {
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
      this.emit(Opcode.SET_LOCAL, local);
      this.emit(Opcode.GET_LOCAL, local);
    } else {
      if (!this.globalNames.has(expr.name.lexeme)) {
        // Assigning an undeclared name is an error, not an implicit global (SPEC 4.5, D3).
        throw new SemanticError(expr.name, "Cannot assign to undefined variable.");
      }
      const nameIdx = this.addConstant(expr.name.lexeme);
      this.emit(Opcode.SET_GLOBAL, nameIdx);
      // Leave the assigned value on the stack to support expression contexts
      this.emit(Opcode.GET_GLOBAL, nameIdx);
    }
  }
  visitCallExpr(expr: any): void {
    // A function value: from an expression, or a variable that holds one (SPEC 4.6).
    if (!(expr.callee instanceof Variable)
      || this.resolveLocal(expr.callee.name.lexeme) !== undefined
      || this.globalNames.has(expr.callee.name.lexeme)) {
      this.compileNode(expr.callee);
      for (const arg of expr.arguments) {
        this.compileNode(arg);
      }
      this.emit(Opcode.CALL_VALUE, expr.arguments.length);
      return;
    }
    const calleeName = expr.callee.name.lexeme;
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
    this.nextLocal++;
    return slot;
  }

  private resolveLocal(name: string): number | undefined {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i];
      if (scope.has(name)) {
        return scope.get(name);
      }
    }
    return undefined;
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

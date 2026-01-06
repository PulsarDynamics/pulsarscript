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
import { TryCatchStmt } from "./classes/TryCatchStmt";
import { ArrayExpr } from "./classes/ArrayExpr";
import { ObjectExpr } from "./classes/ObjectExpr";
import type { FunctionEntry } from "./Bytecode";

/**
 * Very small bytecode compiler that covers literals, unary/binary ops, and print/expr statements.
 * This is a starting point for the Go VM pipeline.
 */
export class BytecodeCompiler implements ExprVisitor<void>, StmtVisitor<void> {
  chunk: Chunk = { constants: [], code: [], functions: [], lineMap: [] };
  scopeStack: Map<string, number>[] = [new Map()];
  nextLocal = 0;
  functions: Map<string, FunctionEntry> = new Map();
  currentLine = 1; // Track current source line for error mapping

  static compile(statements: Stmt[]): Chunk {
    const compiler = new BytecodeCompiler();
    compiler.compile(statements);
    return compiler.chunk;
  }

  compile(statements: Stmt[]): void {
    for (const stmt of statements) {
      stmt.accept(this);
    }
    this.emit(Opcode.HALT);
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
    stmt.expression.accept(this);
    this.emit(Opcode.POP);
  }

  visitPrintStmt(stmt: PrintStmt): void {
    stmt.expression.accept(this);
    this.emit(Opcode.PRINT);
  }

  visitVarStmt(stmt: VarStmt): void {
    this.currentLine = stmt.name.line;
    if (stmt.initializer) {
      stmt.initializer.accept(this);
    } else {
      this.emit(Opcode.CONST, this.addConstant(null));
    }
    const slot = this.declareLocal(stmt.name.lexeme);
    this.emit(Opcode.SET_LOCAL, slot);
  }
  visitBlockStmt(stmt: any): void {
    const startLocal = this.nextLocal;
    this.beginScope();
    const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);
    const statements = stmt.statements ?? [];
    for (const s of statements) {
      s.accept(this);
    }
    const newLocals = this.nextLocal - startLocal;
    this.patchOperand(enterPos, newLocals);
    this.emit(Opcode.EXIT_BLOCK, newLocals);
    this.endScope(startLocal);
  }
  visitIfStmt(stmt: IfStmt): void {
    stmt.condition.accept(this);
    const jumpIfFalsePos = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    stmt.thenBranch.accept(this);
    const jumpPos = this.emitPlaceholder(Opcode.JUMP);
    this.patchJump(jumpIfFalsePos);
    if (stmt.elseBranch) {
      stmt.elseBranch.accept(this);
    }
    this.patchJump(jumpPos);
  }
  visitWhileStmt(stmt: WhileStmt): void {
    const loopStart = this.chunk.code.length;
    stmt.condition.accept(this);
    const exitJump = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    stmt.body.accept(this);
    this.emitJump(loopStart);
    this.patchJump(exitJump);
  }
  visitForStmt(stmt: ForStmt): void {
    // For loops are compiled as: initializer; while(condition) { body; increment; }
    const startLocal = this.nextLocal;
    this.beginScope();
    const enterPos = this.emitPlaceholder(Opcode.ENTER_BLOCK);

    // 1. Execute initializer (if present)
    if (stmt.initializer !== null) {
      stmt.initializer.accept(this);
    }

    // 2. Loop start - evaluate condition
    const loopStart = this.chunk.code.length;
    let exitJump = -1;
    if (stmt.condition !== null) {
      stmt.condition.accept(this);
      exitJump = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    }

    // 3. Execute body
    stmt.body.accept(this);

    // 4. Execute increment (if present)
    if (stmt.increment !== null) {
      stmt.increment.accept(this);
      this.emit(Opcode.POP); // discard increment expression result
    }

    // 5. Jump back to condition check
    this.emitJump(loopStart);

    // 6. Patch exit jump (if condition exists)
    if (exitJump !== -1) {
      this.patchJump(exitJump);
    }

    // Clean up block scope
    const newLocals = this.nextLocal - startLocal;
    this.patchOperand(enterPos, newLocals);
    this.emit(Opcode.EXIT_BLOCK, newLocals);
    this.endScope(startLocal);
  }
  visitFunctionStmt(stmt: FunctionStmt): void {
    // Emit jump over function body so main code skips execution.
    const jumpOver = this.emitPlaceholder(Opcode.JUMP);
    const fnAddr = this.chunk.code.length;
    this.functions.set(stmt.name.lexeme, { name: stmt.name.lexeme, address: fnAddr, arity: stmt.params.length, locals: 0 });
    // Save locals state
    const prevScopes = this.scopeStack;
    const prevNextLocal = this.nextLocal;
    this.scopeStack = [new Map()];
    this.nextLocal = 0;
    // Declare params as locals
    for (const p of stmt.params) {
      this.declareLocal(p.lexeme);
    }
    // Compile body
    for (const st of stmt.body) {
      st.accept(this);
    }
    // Ensure return nil
    this.emit(Opcode.CONST, this.addConstant(null));
    this.emit(Opcode.RETURN);
    const localCount = this.nextLocal;
    this.functions.set(stmt.name.lexeme, { name: stmt.name.lexeme, address: fnAddr, arity: stmt.params.length, locals: localCount });
    this.chunk.functions?.push({ name: stmt.name.lexeme, address: fnAddr, arity: stmt.params.length, locals: localCount });
    // Restore locals
    this.scopeStack = prevScopes;
    this.nextLocal = prevNextLocal;
    // Patch jump over function body
    this.patchJump(jumpOver);
  }
  visitReturnStmt(stmt: ReturnStmt): void {
    if (stmt.value) {
      stmt.value.accept(this);
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

    // Compile try block
    for (const s of stmt.tryBlock) {
      s.accept(this);
    }

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
      const slot = this.declareLocal(stmt.catchParam);
      this.emit(Opcode.SET_LOCAL, slot); // store error from stack
      this.emit(Opcode.POP); // clean up the SET_LOCAL push

      // Compile catch block
      for (const s of stmt.catchBlock) {
        s.accept(this);
      }

      const newLocals = this.nextLocal - startLocal;
      this.patchOperand(enterPos, newLocals);
      this.emit(Opcode.EXIT_BLOCK, newLocals);
      this.endScope(startLocal);
    } else {
      // No catch parameter - just pop the error from stack
      this.emit(Opcode.POP);

      // Compile catch block
      for (const s of stmt.catchBlock) {
        s.accept(this);
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
    expr.expression.accept(this);
  }

  visitUnaryExpr(expr: Unary): void {
    expr.right.accept(this);
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
        expr.left.accept(this);
        expr.right.accept(this);
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
    const nameIdx = this.addConstant(expr.name.lexeme);
    this.emit(Opcode.GET_GLOBAL, nameIdx);
  }
  visitAssignExpr(expr: Assign): void {
    expr.value.accept(this);
    const local = this.resolveLocal(expr.name.lexeme);
    if (local !== undefined) {
      this.emit(Opcode.SET_LOCAL, local);
      this.emit(Opcode.GET_LOCAL, local);
    } else {
      const nameIdx = this.addConstant(expr.name.lexeme);
      this.emit(Opcode.SET_GLOBAL, nameIdx);
      // Leave the assigned value on the stack to support expression contexts
      this.emit(Opcode.GET_GLOBAL, nameIdx);
    }
  }
  visitCallExpr(expr: any): void {
    if (!(expr.callee instanceof Variable)) {
      throw new Error("Only simple function/host calls supported in bytecode yet");
    }
    const calleeName = expr.callee.name.lexeme;
    // evaluate args
    for (const arg of expr.arguments) {
      arg.accept(this);
    }
    const fn = this.functions.get(calleeName);
    if (fn) {
      this.emit(Opcode.CALL, fn.address);
      this.emit(expr.arguments.length);
      return;
    }
    const nameIdx = this.addConstant(calleeName);
    this.emit(Opcode.HOST_CALL, nameIdx);
    this.emit(expr.arguments.length);
  }
  visitErrorExpr(): void { throw new Error("Error expr not supported in bytecode yet"); }

  visitArrayExpr(expr: ArrayExpr): void {
    // Compile each element expression - pushes values onto stack
    for (const element of expr.elements) {
      element.accept(this);
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
      prop.value.accept(this);
    }
    // Emit NEW_OBJECT with property count
    this.emit(Opcode.NEW_OBJECT, expr.properties.length);
  }

  private emitPlaceholder(op: Opcode): number {
    const pos = this.chunk.code.length;
    this.chunk.code.push(op, 0); // placeholder operand
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

  private emitLogicalAnd(expr: Binary) {
    expr.left.accept(this);
    const jumpIfFalse = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    this.emit(Opcode.POP);
    expr.right.accept(this);
    this.patchJump(jumpIfFalse);
  }

  private emitLogicalOr(expr: Binary) {
    expr.left.accept(this);
    const jumpIfFalse = this.emitPlaceholder(Opcode.JUMP_IF_FALSE);
    const jumpOverRight = this.emitPlaceholder(Opcode.JUMP);
    this.patchJump(jumpIfFalse);
    this.emit(Opcode.POP);
    expr.right.accept(this);
    this.patchJump(jumpOverRight);
  }
}

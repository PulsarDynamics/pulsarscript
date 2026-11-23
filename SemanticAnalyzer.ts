import type { Assign } from "./classes/Assign";
import { Binary } from "./classes/Binary";
import { BlockStmt } from "./classes/BlockStmt";
import type { Call } from "./classes/Call";
import { ExpressionStmt } from "./classes/ExpressionStmt";
import { FunctionStmt } from "./classes/FunctionStmt";
import { ForStmt as ForStmtClass, type ForStmt } from "./classes/ForStmt";
import type { Grouping } from "./classes/Grouping";
import { IfStmt } from "./classes/IfStmt";
import { Literal } from "./classes/Literal";
import { PrintStmt } from "./classes/PrintStmt";
import { ReturnStmt } from "./classes/ReturnStmt";
import type { Unary } from "./classes/Unary";
import { VarStmt } from "./classes/VarStmt";
import { Variable } from "./classes/Variable";
import { WhileStmt } from "./classes/WhileStmt";
import type { ArrayExpr } from "./classes/ArrayExpr";
import type { ObjectExpr } from "./classes/ObjectExpr";
import { TryCatchStmt } from "./classes/TryCatchStmt";
import type { ErrorExpr } from "./classes/ErrorExpr";
import { TokenType } from "./enums/TokenType";
import type { Expr } from "./interfaces/Expr";
import type { ExprVisitor } from "./interfaces/ExprVisitor";
import type { Stmt } from "./interfaces/Stmt";
import type { StmtVisitor } from "./interfaces/StmtVisitor";
import type { Token } from "./interfaces/Token";
import { arityError, lookupHostFunction } from "./HostApi";
import { IndexExpr } from "./classes/IndexExpr";
import { SetIndex } from "./classes/SetIndex";
import { BreakStmt as BreakStmtClass, type BreakStmt } from "./classes/BreakStmt";
import { ForOfStmt as ForOfStmtClass, type ForOfStmt } from "./classes/ForOfStmt";
import type { TernaryExpr } from "./classes/TernaryExpr";
import type { TemplateLiteralExpr } from "./classes/TemplateLiteralExpr";
import type { FunctionExpr } from "./classes/FunctionExpr";
import type { ImportStmt } from "./classes/ImportStmt";
import { ExportStmt } from "./classes/ExportStmt";

export class SemanticAnalyzer implements ExprVisitor<void>, StmtVisitor<void> {
    // Built-ins and host calls come from hostapi.json (SPEC §8); they are callable, not values.
    private environment: Environment = new Environment();
    private currentFunction: FunctionType = FunctionType.NONE;
  
    /** Top-level functions declared up front so they can be called before their declaration (D2). */
    private hoisted = new Set<FunctionStmt>();
    /** Top-level `var` names: globals that function bodies may use even if declared later (SPEC 6, D1). */
    private topLevelVars = new Set<string>();
    /** Top-level `const` names, so a function body cannot assign to one declared later. */
    private topLevelConsts = new Set<string>();
    /** Nested block depth inside top-level script or functions. */
    private blockDepth = 0;
    /** Warnings emitted during semantic analysis (e.g., calls to deprecated APIs). */
    public warnings: { line: number; column?: number; message: string }[] = [];
    /** Loops enclosing the current statement inside the current function (for break/continue). */
    private loopDepth = 0;
    /** Set while analyzing an expression statement or for-increment, where element assignment may appear. */
    private statementLevel: Expr | null = null;

    /** Inside a function body, a top-level variable declared anywhere in the file is in scope. */
    private isLaterGlobal(name: Token): boolean {
      return this.currentFunction !== FunctionType.NONE && this.topLevelVars.has(name.lexeme);
    }

    analyze(statements: Stmt[]): void {
      for (const raw of statements) {
        const statement = raw instanceof ExportStmt && raw.declaration ? raw.declaration : raw;
        if (statement instanceof VarStmt) {
          this.topLevelVars.add(statement.name.lexeme);
          if (statement.isConst) this.topLevelConsts.add(statement.name.lexeme);
        }
        if (statement instanceof FunctionStmt) {
          if (this.topLevelVars.has(statement.name.lexeme)) {
            throw new SemanticError(statement.name, "Variable with this name already declared in this scope.");
          }
          this.declareFunction(statement.name, statement);
          this.hoisted.add(statement);
        }
      }
      this.analyzeStatements(statements);
    }

    private analyzeStatements(statements: Stmt[]): void {
      let terminated = false;
      for (const statement of statements) {
        if (terminated) {
          throw new SemanticError(this.statementToken(statement), "Unreachable code.");
        }
        this.analyzeStmt(statement);
        if (this.statementTerminates(statement)) {
          terminated = true;
        }
      }
    }

    private statementTerminates(stmt: Stmt): boolean {
      if (stmt instanceof ReturnStmt || stmt instanceof BreakStmtClass) {
        return true;
      }
      if (stmt instanceof BlockStmt) {
        for (const s of stmt.statements) {
          if (this.statementTerminates(s)) return true;
        }
        return false;
      }
      if (stmt instanceof IfStmt) {
        return stmt.elseBranch !== null
          && this.statementTerminates(stmt.thenBranch)
          && this.statementTerminates(stmt.elseBranch);
      }
      if (stmt instanceof TryCatchStmt) {
        return stmt.tryBlock.some((s) => this.statementTerminates(s))
          && stmt.catchBlock.some((s) => this.statementTerminates(s));
      }
      return false;
    }

    private statementToken(stmt: Stmt): Token {
      const line = (stmt as any).line ?? 0;
      if (stmt instanceof VarStmt || stmt instanceof FunctionStmt) return stmt.name;
      if (stmt instanceof ReturnStmt || stmt instanceof BreakStmtClass) return stmt.keyword;
      if (stmt instanceof ForOfStmtClass) return stmt.name;
      if (stmt instanceof PrintStmt) return { type: TokenType.PRINT, lexeme: "print", literal: null, line };
      if (stmt instanceof IfStmt) return { type: TokenType.IF, lexeme: "if", literal: null, line };
      if (stmt instanceof WhileStmt) return { type: TokenType.WHILE, lexeme: "while", literal: null, line };
      if (stmt instanceof ForStmtClass) return { type: TokenType.FOR, lexeme: "for", literal: null, line };
      if (stmt instanceof TryCatchStmt) return { type: TokenType.TRY, lexeme: "try", literal: null, line };
      if (stmt instanceof BlockStmt) {
        return stmt.statements.length > 0
          ? this.statementToken(stmt.statements[0])
          : { type: TokenType.LEFT_BRACE, lexeme: "{", literal: null, line };
      }
      if (stmt instanceof ExpressionStmt) {
        const e: any = stmt.expression;
        if (e?.name) return e.name;
        if (e?.operator) return e.operator;
        if (e?.paren) return e.paren;
        if (e?.equals) return e.equals;
        if (e?.token) return e.token;
        if (e?.keyword) return e.keyword;
      }
      return { type: TokenType.SEMICOLON, lexeme: "", literal: null, line };
    }
  
    private analyzeStmt(stmt: Stmt): void {
      stmt.accept(this);
    }
  
    private analyzeExpr(expr: Expr): void {
      //console.log("expr", expr)
      //console.log("this", this)
      expr.accept(this);
    }
  
    visitBlockStmt(stmt: BlockStmt): void {
      this.beginScope();
      this.analyzeStatements(stmt.statements);
      this.endScope();
    }
  
    visitVarStmt(stmt: VarStmt): void {
      if (stmt.initializer !== null) {
        this.analyzeExpr(stmt.initializer);
      }
      this.declareVariable(stmt.name, stmt.isConst);
    }
  
  visitVariableExpr(expr: Variable): void {
    // Allow reference to built-in globals (standard library) by whitelisting names.
    if (!this.environment.isDefined(expr.name) && !this.isLaterGlobal(expr.name)) {
        throw new SemanticError(expr.name, "Variable is not defined.");
    }
  }

  visitAssignExpr(expr: Assign): void {
    this.analyzeExpr(expr.value);
    this.checkAssignable(expr.name);
  }

  /** A variable that may be assigned: defined, not a constant, not a function. */
  private checkAssignable(name: Token): void {
    if (!this.environment.isDefined(name) && !this.isLaterGlobal(name)) {
        throw new SemanticError(name, "Cannot assign to undefined variable.");
    }
    if (this.environment.isConst(name) || (!this.environment.isDefined(name) && this.topLevelConsts.has(name.lexeme))) {
        throw new SemanticError(name, `Cannot assign to constant '${name.lexeme}'.`);
    }
    if (this.environment.getFunction(name) !== null && !this.environment.isValue(name)) {
        throw new SemanticError(name, `Cannot assign to function '${name.lexeme}'.`);
    }
  }

  visitIndexExpr(expr: IndexExpr): void {
    this.analyzeExpr(expr.object);
    this.analyzeExpr(expr.index);
  }

  visitSetIndexExpr(expr: SetIndex): void {
    if (this.statementLevel !== expr) {
      throw new SemanticError(expr.equals, "Assignment to an element or property must be a statement of its own.");
    }
    // Walk to the variable at the root of the target: a[i][j].k -> a.
    const keys: Expr[] = [];
    let node: Expr = expr.target;
    while (node instanceof IndexExpr) {
      keys.push(node.index);
      node = node.object;
    }
    if (!(node instanceof Variable)) {
      throw new SemanticError(expr.equals, "Invalid assignment target: it must start with a variable.");
    }
    this.checkAssignable(node.name);
    this.statementLevel = null;
    this.analyzeExpr(expr.target);
    this.analyzeExpr(expr.value);
  }

  visitTernaryExpr(expr: TernaryExpr): void {
    this.analyzeExpr(expr.condition);
    this.analyzeExpr(expr.thenBranch);
    this.analyzeExpr(expr.elseBranch);
  }

  visitTemplateLiteralExpr(expr: TemplateLiteralExpr): void {
    for (const part of expr.parts) {
      this.analyzeExpr(part);
    }
  }

  visitFunctionExpr(expr: FunctionExpr): void {
    const hasOuterSelf = expr.name !== null;
    if (hasOuterSelf) {
      this.beginScope();
      this.declareVariable(expr.name!, true);
    }
    this.beginScope();
    for (const param of expr.params) {
      this.declareVariable(param);
    }
    const enclosingFunction = this.currentFunction;
    const enclosingLoops = this.loopDepth;
    this.currentFunction = FunctionType.FUNCTION;
    this.loopDepth = 0;
    this.analyzeStatements(expr.body);
    this.currentFunction = enclosingFunction;
    this.loopDepth = enclosingLoops;
    this.endScope();
    if (hasOuterSelf) {
      this.endScope();
    }
  }

  visitBreakStmt(stmt: BreakStmt): void {
    if (this.loopDepth === 0) {
      throw new SemanticError(stmt.keyword, `'${stmt.keyword.lexeme}' must be inside a loop.`);
    }
  }

  visitForOfStmt(stmt: ForOfStmt): void {
    this.analyzeExpr(stmt.iterable);
    this.beginScope();
    this.declareVariable(stmt.name, stmt.isConst);
    this.loopDepth++;
    this.analyzeStmt(stmt.body);
    this.loopDepth--;
    this.endScope();
  }

  visitFunctionStmt(stmt: FunctionStmt): void {
      if (!this.hoisted.has(stmt)) {
        this.declareFunction(stmt.name, stmt);
      }
      this.beginScope();
      for (const param of stmt.params) {
        this.declareVariable(param);
      }
      const enclosingFunction = this.currentFunction;
      const enclosingLoops = this.loopDepth;
      this.currentFunction = FunctionType.FUNCTION;
      this.loopDepth = 0;
      this.analyzeStatements(stmt.body);
      this.currentFunction = enclosingFunction;
      this.loopDepth = enclosingLoops;
      this.endScope();
    }
  
    visitExpressionStmt(stmt: ExpressionStmt): void {
      this.statementLevel = stmt.expression;
      this.analyzeExpr(stmt.expression);
      this.statementLevel = null;
    }
  
    visitIfStmt(stmt: IfStmt): void {
      this.analyzeExpr(stmt.condition);
      this.analyzeStmt(stmt.thenBranch);
      if (stmt.elseBranch !== null) {
        this.analyzeStmt(stmt.elseBranch);
      }
    }
  
    visitPrintStmt(stmt: PrintStmt): void {
      this.analyzeExpr(stmt.expression);
    }
  
    visitReturnStmt(stmt: ReturnStmt): void {
      if (this.currentFunction === FunctionType.NONE) {
        throw new SemanticError(stmt.keyword, "Cannot return from top-level code.");
      }
      if (stmt.value !== null) {
        this.analyzeExpr(stmt.value);
      }
    }
  
  visitWhileStmt(stmt: WhileStmt): void {
    this.analyzeExpr(stmt.condition);
    this.loopDepth++;
    this.analyzeStmt(stmt.body);
    this.loopDepth--;
  }

  visitForStmt(stmt: ForStmt): void {
    this.beginScope();
    if (stmt.initializer !== null) {
      this.analyzeStmt(stmt.initializer);
    }
    if (stmt.condition !== null) {
      this.analyzeExpr(stmt.condition);
    }
    if (stmt.increment !== null) {
      this.statementLevel = stmt.increment;
      this.analyzeExpr(stmt.increment);
      this.statementLevel = null;
    }
    this.loopDepth++;
    this.analyzeStmt(stmt.body);
    this.loopDepth--;
    this.endScope();
  }

  visitBinaryExpr(expr: Binary): void {
    this.analyzeExpr(expr.left);
    this.analyzeExpr(expr.right);
  }

  visitCallExpr(expr: Call): void {
      for (const arg of expr.arguments) {
        this.analyzeExpr(arg);
      }
      if (!(expr.callee instanceof Variable)) {
        // A function value from an expression: fns[0](x), handlers.save(x). Checked when called.
        this.analyzeExpr(expr.callee);
        return;
      }
      const name = expr.callee.name;
      const funcDecl = this.environment.isValue(name) ? null : this.environment.getFunction(name);
      if (funcDecl !== null) {
        // User-defined function (shadows a built-in of the same name)
        if (expr.arguments.length !== funcDecl.params.length) {
          throw new SemanticError(expr.paren, `Expected ${funcDecl.params.length} arguments but got ${expr.arguments.length}.`);
        }
        return;
      }
      if (this.environment.isDefined(name) || this.isLaterGlobal(name)) {
        // A variable holding a function value; its arity is checked when called.
        return;
      }
      // Otherwise it must be a registered built-in or host call; unknown names fail here (D3).
      const host = lookupHostFunction(name.lexeme);
      if (!host) {
        throw new SemanticError(name, `Unknown function '${name.lexeme}'.`);
      }
      const arity = arityError(host, expr.arguments.length);
      if (arity) throw new SemanticError(expr.paren, arity);
      if (host.deprecated) {
        this.warnings.push({
          line: name.line,
          column: name.column,
          message: `${host.name} is deprecated: ${host.deprecated}`,
        });
      }
    }

    visitGroupingExpr(expr: Grouping): void {
      this.analyzeExpr(expr.expression);
    }
  
    visitLiteralExpr(expr: Literal): void {
      // Nothing to do for literals
    }
  
    visitUnaryExpr(expr: Unary): void {
      this.analyzeExpr(expr.right);
      // You could add type checking here if MiniScript had static types
    }
  
    visitArrayExpr(expr: ArrayExpr): void {
      for (const element of expr.elements) {
        this.analyzeExpr(element);
      }
    }

    visitObjectExpr(expr: ObjectExpr): void {
      for (const prop of expr.properties) {
        this.analyzeExpr(prop.value);
      }
    }

    visitErrorExpr(_expr: ErrorExpr): void {
      // Error nodes carry no sub-expressions to analyze.
    }

    visitTryCatchStmt(stmt: TryCatchStmt): void {
      this.beginScope();
      this.analyzeStatements(stmt.tryBlock);
      this.endScope();
      this.beginScope();
      if (stmt.catchParam !== null) {
        const tok = { type: TokenType.IDENTIFIER, lexeme: stmt.catchParam, literal: null, line: 0 } as Token;
        this.declareVariable(tok);
      }
      this.analyzeStatements(stmt.catchBlock);
      this.endScope();
    }

    private declareVariable(name: Token, isConst = false): void {
      if (this.environment.existsInCurrentScope(name)) {
        throw new SemanticError(name, "Variable with this name already declared in this scope.");
      }
      this.environment.define(name, isConst ? CONST_MARK : null);
    }

    private declareFunction(name: Token, stmt: FunctionStmt): void {
      if (this.environment.existsInCurrentScope(name)) {
        throw new SemanticError(name, "Variable with this name already declared in this scope.");
      }
      this.environment.defineFunction(name, stmt);
    }
  
    visitImportStmt(stmt: ImportStmt): void {
      throw new SemanticError(stmt.keyword, "Imports must be resolved by the module linker before compilation.");
    }

    visitExportStmt(stmt: ExportStmt): void {
      if (this.currentFunction !== FunctionType.NONE || this.blockDepth > 0) {
        throw new SemanticError(stmt.keyword, "'export' is only allowed at the top level.");
      }
      if (stmt.declaration) {
        this.analyzeStmt(stmt.declaration);
      }
      if (stmt.specifiers) {
        for (const spec of stmt.specifiers) {
          if (!this.environment.isDefined(spec.local)) {
            throw new SemanticError(spec.local, `Undefined exported symbol '${spec.local.lexeme}'.`);
          }
        }
      }
    }

    private beginScope(): void {
      this.blockDepth++;
      this.environment = new Environment(this.environment);
    }
  
    private endScope(): void {
      this.blockDepth--;
      this.environment = this.environment.enclosing!;
    }
  }
  
  class Environment {
    enclosing: Environment | null;
    values: Map<string, any> = new Map();
    functions: Map<string, FunctionStmt> = new Map();
  
    constructor(enclosing: Environment | null = null) {
      this.enclosing = enclosing;
    }
  
    define(name: Token, value: any): void {
      this.values.set(name.lexeme, value);
    }

    defineFunction(name: Token, func: FunctionStmt): void {
      this.functions.set(name.lexeme, func);
    }

    getFunction(name: Token): FunctionStmt | null {
      if (this.functions.has(name.lexeme)) {
        return this.functions.get(name.lexeme)!;
      }
      if (this.enclosing !== null) {
        return this.enclosing.getFunction(name);
      }
      return null;
    }
  
    get(name: Token): any {
    if (this.values.has(name.lexeme)) {
      return this.values.get(name.lexeme);
    }
    if (this.enclosing !== null) {
      return this.enclosing.get(name);
    }
    return null;
  }

  isDefined(name: Token): boolean {
    if (this.values.has(name.lexeme)) {
      return true;
    }
    if (this.functions.has(name.lexeme)) {
      return true;
    }
    if (this.enclosing !== null) {
      return this.enclosing.isDefined(name);
    }
    return false;
  }

  /** The nearest binding of `name` is a constant. */
  isConst(name: Token): boolean {
    if (this.values.has(name.lexeme)) return this.values.get(name.lexeme) === CONST_MARK;
    if (this.functions.has(name.lexeme)) return false;
    return this.enclosing !== null && this.enclosing.isConst(name);
  }

  /** The nearest binding of `name` is a variable (not a function declaration). */
  isValue(name: Token): boolean {
    if (this.values.has(name.lexeme)) return true;
    if (this.functions.has(name.lexeme)) return false;
    return this.enclosing !== null && this.enclosing.isValue(name);
  }

  existsInCurrentScope(name: Token): boolean {
    return this.values.has(name.lexeme) || this.functions.has(name.lexeme);
  }
}

  /** Marks a `const` binding in Environment.values. */
  const CONST_MARK = Symbol("const");

  enum FunctionType {
    NONE,
    FUNCTION
  }
  
  export class SemanticError extends Error {
    token: Token;
  
    constructor(token: Token, message: string) {
      super(message);
      this.token = token;
    }
  }

/*
  // Example usage:
  const lexer = new Lexer(sourceCode);
  const tokens = lexer.scanTokens();
  const parser = new Parser(tokens);
  const statements = parser.parse();
  
  const analyzer = new SemanticAnalyzer();
  try {
    analyzer.analyze(statements);
    console.log("Semantic analysis completed successfully.");
  } catch (error) {
    if (error instanceof SemanticError) {
      console.error(`Semantic error at '${error.token.lexeme}': ${error.message}`);
    } else {
      console.error("An unexpected error occurred during semantic analysis:", error);
    }
  }
*/
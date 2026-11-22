import type { Assign } from "./classes/Assign";
import { Binary } from "./classes/Binary";
import type { BlockStmt } from "./classes/BlockStmt";
import type { Call } from "./classes/Call";
import type { ExpressionStmt } from "./classes/ExpressionStmt";
import { FunctionStmt } from "./classes/FunctionStmt";
import type { ForStmt } from "./classes/ForStmt";
import type { Grouping } from "./classes/Grouping";
import type { IfStmt } from "./classes/IfStmt";
import { Literal } from "./classes/Literal";
import type { PrintStmt } from "./classes/PrintStmt";
import type { ReturnStmt } from "./classes/ReturnStmt";
import type { Unary } from "./classes/Unary";
import { VarStmt } from "./classes/VarStmt";
import { Variable } from "./classes/Variable";
import type { WhileStmt } from "./classes/WhileStmt";
import type { ArrayExpr } from "./classes/ArrayExpr";
import type { ObjectExpr } from "./classes/ObjectExpr";
import type { TryCatchStmt } from "./classes/TryCatchStmt";
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
import type { BreakStmt } from "./classes/BreakStmt";
import type { ForOfStmt } from "./classes/ForOfStmt";

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
    /** Loops enclosing the current statement inside the current function (for break/continue). */
    private loopDepth = 0;
    /** Set while analyzing an expression statement or for-increment, where element assignment may appear. */
    private statementLevel: Expr | null = null;

    /** Inside a function body, a top-level variable declared anywhere in the file is in scope. */
    private isLaterGlobal(name: Token): boolean {
      return this.currentFunction !== FunctionType.NONE && this.topLevelVars.has(name.lexeme);
    }

    analyze(statements: Stmt[]): void {
      for (const statement of statements) {
        if (statement instanceof VarStmt) {
          this.topLevelVars.add(statement.name.lexeme);
          if (statement.isConst) this.topLevelConsts.add(statement.name.lexeme);
        }
        if (statement instanceof FunctionStmt) {
          this.declareVariable(statement.name);
          this.environment.defineFunction(statement.name, statement);
          this.hoisted.add(statement);
        }
      }
      for (const statement of statements) {
        this.analyzeStmt(statement);
      }
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
      for (const statement of stmt.statements) {
        this.analyzeStmt(statement);
      }
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
    // Nested or compound targets read their keys more than once; keys must not have side effects.
    const compound = expr.value instanceof Binary && expr.value.left === expr.target;
    if (keys.length > 1 || compound) {
      for (const key of keys) {
        if (!(key instanceof Literal) && !(key instanceof Variable)) {
          throw new SemanticError(expr.equals, "In a nested or compound element assignment, each index must be a literal or a variable.");
        }
      }
    }
    this.statementLevel = null;
    this.analyzeExpr(expr.target);
    this.analyzeExpr(expr.value);
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
        this.declareVariable(stmt.name);
        this.environment.defineFunction(stmt.name, stmt);
      }
      this.beginScope();
      for (const param of stmt.params) {
        this.declareVariable(param);
      }
      const enclosingFunction = this.currentFunction;
      const enclosingLoops = this.loopDepth;
      this.currentFunction = FunctionType.FUNCTION;
      this.loopDepth = 0;
      for (const bodyStmt of stmt.body) {
        this.analyzeStmt(bodyStmt);
      }
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
      for (const s of stmt.tryBlock) {
        this.analyzeStmt(s);
      }
      this.endScope();
      this.beginScope();
      if (stmt.catchParam !== null) {
        const tok = { type: TokenType.IDENTIFIER, lexeme: stmt.catchParam, literal: null, line: 0 } as Token;
        this.declareVariable(tok);
      }
      for (const s of stmt.catchBlock) {
        this.analyzeStmt(s);
      }
      this.endScope();
    }

    private declareVariable(name: Token, isConst = false): void {
      if (this.environment.existsInCurrentScope(name)) {
        throw new SemanticError(name, "Variable with this name already declared in this scope.");
      }
      this.environment.define(name, isConst ? CONST_MARK : null);
    }
  
    private beginScope(): void {
      this.environment = new Environment(this.environment);
    }
  
    private endScope(): void {
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
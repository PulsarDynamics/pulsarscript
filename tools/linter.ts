import { readFileSync } from "node:fs";
import { HOST_FUNCTIONS, arityError, type HostFunction } from "../HostApi";
import { Lexer } from "../Lexer";
import { ParseError, Parser } from "../Parser";
import type { Token } from "../interfaces/Token";
import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import { ArrayExpr } from "../classes/ArrayExpr";
import { Assign } from "../classes/Assign";
import { Binary } from "../classes/Binary";
import { BlockStmt } from "../classes/BlockStmt";
import { BreakStmt } from "../classes/BreakStmt";
import { Call } from "../classes/Call";
import { ExportStmt } from "../classes/ExportStmt";
import { ExpressionStmt } from "../classes/ExpressionStmt";
import { ForOfStmt } from "../classes/ForOfStmt";
import { ForStmt } from "../classes/ForStmt";
import { FunctionExpr } from "../classes/FunctionExpr";
import { FunctionStmt } from "../classes/FunctionStmt";
import { Grouping } from "../classes/Grouping";
import { IfStmt } from "../classes/IfStmt";
import { ImportStmt } from "../classes/ImportStmt";
import { IndexExpr } from "../classes/IndexExpr";
import { Literal } from "../classes/Literal";
import { ObjectExpr } from "../classes/ObjectExpr";
import { PrintStmt } from "../classes/PrintStmt";
import { ReturnStmt } from "../classes/ReturnStmt";
import { SetIndex } from "../classes/SetIndex";
import { TemplateLiteralExpr } from "../classes/TemplateLiteralExpr";
import { TernaryExpr } from "../classes/TernaryExpr";
import { TryCatchStmt } from "../classes/TryCatchStmt";
import { Unary } from "../classes/Unary";
import { VarStmt } from "../classes/VarStmt";
import { Variable } from "../classes/Variable";
import { WhileStmt } from "../classes/WhileStmt";
import {
  extractManifestScopes,
  findManifestForFile,
  type AppManifestLike,
} from "./manifest-validator";

export type LintSeverity = "error" | "warning";

export interface LintDiagnostic {
  rule: string;
  severity: LintSeverity;
  message: string;
  line: number;
  column: number;
  endColumn?: number;
  file?: string;
}

export interface LintOptions {
  filePath?: string;
  manifestPath?: string;
  manifest?: Partial<AppManifestLike> | null;
  registry?: readonly HostFunction[];
}

interface SymbolBinding {
  name: string;
  kind: "var" | "const" | "function" | "param" | "import" | "catch";
  line: number;
  column: number;
  endColumn: number;
  used: boolean;
  exported: boolean;
  arity?: number;
  scopeId: number;
}

class Scope {
  readonly id: number;
  readonly parent: Scope | null;
  readonly isFunctionBoundary: boolean;
  readonly ownerSymbol: SymbolBinding | null;
  readonly symbols = new Map<string, SymbolBinding>();

  constructor(id: number, parent: Scope | null, isFunctionBoundary = false, ownerSymbol: SymbolBinding | null = null) {
    this.id = id;
    this.parent = parent;
    this.isFunctionBoundary = isFunctionBoundary;
    this.ownerSymbol = ownerSymbol;
  }

  lookup(name: string): SymbolBinding | undefined {
    const direct = this.symbols.get(name);
    if (direct) return direct;
    return this.parent?.lookup(name);
  }

  lookupEnclosing(name: string): SymbolBinding | undefined {
    return this.parent?.lookup(name);
  }
}

function stmtTerminates(stmt: Stmt): boolean {
  if (stmt instanceof ReturnStmt || stmt instanceof BreakStmt) return true;
  if (stmt instanceof BlockStmt) return stmt.statements.some(stmtTerminates);
  if (stmt instanceof IfStmt) {
    return stmt.elseBranch !== null && stmtTerminates(stmt.thenBranch) && stmtTerminates(stmt.elseBranch);
  }
  if (stmt instanceof TryCatchStmt) {
    return stmt.tryBlock.some(stmtTerminates) && stmt.catchBlock.some(stmtTerminates);
  }
  return false;
}

function tokenPosition(stmt: Stmt): { line: number; column: number } {
  const anyS = stmt as unknown as { line?: number; name?: Token; keyword?: Token; expression?: unknown };
  if (stmt instanceof VarStmt || stmt instanceof FunctionStmt) {
    return { line: stmt.name.line, column: stmt.name.column ?? 1 };
  }
  if (stmt instanceof ReturnStmt || stmt instanceof BreakStmt || stmt instanceof ImportStmt || stmt instanceof ExportStmt) {
    return { line: stmt.keyword.line, column: stmt.keyword.column ?? 1 };
  }
  if (stmt instanceof ForOfStmt) {
    return { line: stmt.name.line, column: stmt.name.column ?? 1 };
  }
  return { line: anyS.line ?? 1, column: 1 };
}

class LinterEngine {
  private readonly diagnostics: LintDiagnostic[] = [];
  private readonly allSymbols: SymbolBinding[] = [];
  private readonly registryMap = new Map<string, HostFunction>();
  private readonly manifestScopes: Set<string> | null;
  private readonly filePath?: string;
  private nextScopeId = 1;
  private rootScope: Scope;
  private currentScope: Scope;
  private currentFunctionOwners = new Set<SymbolBinding>();

  constructor(opts: LintOptions) {
    this.filePath = opts.filePath;
    for (const fn of opts.registry ?? HOST_FUNCTIONS) {
      this.registryMap.set(fn.name, fn);
    }
    this.manifestScopes = resolveManifestScopes(opts);
    this.rootScope = new Scope(this.nextScopeId++, null, false);
    this.currentScope = this.rootScope;
  }

  lint(statements: Stmt[]): LintDiagnostic[] {
    // Pass 1: Hoist top-level bindings (vars, consts, functions, imports, exports)
    // so forward calls and global shadowing are detected accurately.
    for (const raw of statements) {
      if (raw instanceof ImportStmt) {
        for (const spec of raw.specifiers) {
          this.declare(this.rootScope, spec.local, "import", false);
        }
        continue;
      }
      if (raw instanceof ExportStmt) {
        if (raw.declaration) {
          const d = raw.declaration;
          if (d instanceof VarStmt) {
            this.declare(this.rootScope, d.name, d.isConst ? "const" : "var", true);
          } else if (d instanceof FunctionStmt) {
            this.declare(this.rootScope, d.name, "function", true, d.params.length);
          }
        } else if (raw.specifiers) {
          for (const spec of raw.specifiers) {
            const sym = this.rootScope.lookup(spec.local.lexeme);
            if (sym) {
              sym.used = true;
              sym.exported = true;
            }
          }
        }
        continue;
      }
      if (raw instanceof VarStmt) {
        this.declare(this.rootScope, raw.name, raw.isConst ? "const" : "var", false);
      } else if (raw instanceof FunctionStmt) {
        this.declare(this.rootScope, raw.name, "function", false, raw.params.length);
      }
    }

    // Pass 2: Walk statements, check reachability, shadowing, host calls, capabilities, and usage.
    this.walkStatementList(statements, true);

    // Pass 3: Report unused bindings (excluding `_`-prefixed names, exports, and registered handlers).
    for (const sym of this.allSymbols) {
      if (sym.used || sym.exported || sym.name.startsWith("_")) continue;
      const kindLabel =
        sym.kind === "param"
          ? "Parameter"
          : sym.kind === "function"
            ? "Function"
            : sym.kind === "import"
              ? "Imported symbol"
              : sym.kind === "catch"
                ? "Catch parameter"
                : "Variable";
      this.addDiag({
        rule: "no-unused-vars",
        severity: "warning",
        message: `${kindLabel} '${sym.name}' is declared but never used.`,
        line: sym.line,
        column: sym.column,
        endColumn: sym.endColumn,
      });
    }

    this.diagnostics.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
    return this.diagnostics;
  }

  private addDiag(d: LintDiagnostic): void {
    this.diagnostics.push(this.filePath ? { ...d, file: this.filePath } : d);
  }

  private declare(
    scope: Scope,
    tok: Token,
    kind: SymbolBinding["kind"],
    exported: boolean,
    arity?: number
  ): SymbolBinding {
    const col = tok.column ?? 1;
    const endCol = tok.endColumn ?? col + Math.max(1, tok.lexeme.length);
    const existingSame = scope.symbols.get(tok.lexeme);
    if (existingSame) {
      return existingSame;
    }

    // Check shadowing against enclosing scopes.
    const shadowed = scope.lookupEnclosing(tok.lexeme);
    if (shadowed && !tok.lexeme.startsWith("_")) {
      this.addDiag({
        rule: "no-shadow",
        severity: "warning",
        message: `'${tok.lexeme}' shadows a ${shadowed.kind} declared on line ${shadowed.line}.`,
        line: tok.line,
        column: col,
        endColumn: endCol,
      });
    }

    const sym: SymbolBinding = {
      name: tok.lexeme,
      kind,
      line: tok.line,
      column: col,
      endColumn: endCol,
      used: false,
      exported,
      arity,
      scopeId: scope.id,
    };
    scope.symbols.set(tok.lexeme, sym);
    this.allSymbols.push(sym);
    return sym;
  }

  private markUsed(name: string): SymbolBinding | undefined {
    const sym = this.currentScope.lookup(name);
    if (sym) {
      // Do not mark a function used solely because it calls itself recursively.
      if (!this.currentFunctionOwners.has(sym)) {
        sym.used = true;
      }
      return sym;
    }
    return undefined;
  }

  private walkStatementList(statements: Stmt[], isTopLevel = false): void {
    let terminated = false;
    let warnedUnreachable = false;
    for (const raw of statements) {
      if (raw instanceof ImportStmt) continue;
      if (raw instanceof ExportStmt) {
        if (raw.declaration) {
          this.walkStmt(raw.declaration, isTopLevel);
        } else if (raw.specifiers) {
          for (const spec of raw.specifiers) {
            const sym = this.currentScope.lookup(spec.local.lexeme);
            if (sym) sym.used = true;
          }
        }
        continue;
      }
      if (terminated && !warnedUnreachable) {
        const pos = tokenPosition(raw);
        this.addDiag({
          rule: "unreachable-code",
          severity: "warning",
          message: "Unreachable code.",
          line: pos.line,
          column: pos.column,
        });
        warnedUnreachable = true;
      }
      this.walkStmt(raw, isTopLevel);
      if (stmtTerminates(raw)) {
        terminated = true;
      }
    }
  }

  private walkStmt(stmt: Stmt, isTopLevel = false): void {
    if (stmt instanceof BlockStmt) {
      const prev = this.currentScope;
      this.currentScope = new Scope(this.nextScopeId++, prev);
      this.walkStatementList(stmt.statements, false);
      this.currentScope = prev;
      return;
    }

    if (stmt instanceof VarStmt) {
      if (stmt.initializer !== null) {
        this.walkExpr(stmt.initializer);
      }
      if (!isTopLevel) {
        this.declare(this.currentScope, stmt.name, stmt.isConst ? "const" : "var", false);
      }
      return;
    }

    if (stmt instanceof FunctionStmt) {
      const fnSym = isTopLevel
        ? this.rootScope.lookup(stmt.name.lexeme) ?? null
        : this.declare(this.currentScope, stmt.name, "function", false, stmt.params.length);

      const prevScope = this.currentScope;
      const fnScope = new Scope(this.nextScopeId++, prevScope, true, fnSym);
      this.currentScope = fnScope;
      if (fnSym) this.currentFunctionOwners.add(fnSym);
      for (const p of stmt.params) {
        this.declare(fnScope, p, "param", false);
      }
      this.walkStatementList(stmt.body, false);
      if (fnSym) this.currentFunctionOwners.delete(fnSym);
      this.currentScope = prevScope;
      return;
    }

    if (stmt instanceof ExpressionStmt) {
      this.walkExpr(stmt.expression);
      return;
    }

    if (stmt instanceof PrintStmt) {
      this.walkExpr(stmt.expression);
      return;
    }

    if (stmt instanceof ReturnStmt) {
      if (stmt.value) this.walkExpr(stmt.value);
      return;
    }

    if (stmt instanceof BreakStmt) {
      return;
    }

    if (stmt instanceof IfStmt) {
      this.walkExpr(stmt.condition);
      this.walkStmt(stmt.thenBranch, false);
      if (stmt.elseBranch) this.walkStmt(stmt.elseBranch, false);
      return;
    }

    if (stmt instanceof WhileStmt) {
      this.walkExpr(stmt.condition);
      this.walkStmt(stmt.body, false);
      return;
    }

    if (stmt instanceof ForStmt) {
      const prev = this.currentScope;
      this.currentScope = new Scope(this.nextScopeId++, prev);
      if (stmt.initializer) this.walkStmt(stmt.initializer, false);
      if (stmt.condition) this.walkExpr(stmt.condition);
      if (stmt.increment) this.walkExpr(stmt.increment);
      this.walkStmt(stmt.body, false);
      this.currentScope = prev;
      return;
    }

    if (stmt instanceof ForOfStmt) {
      this.walkExpr(stmt.iterable);
      const prev = this.currentScope;
      this.currentScope = new Scope(this.nextScopeId++, prev);
      this.declare(this.currentScope, stmt.name, "var", false);
      this.walkStmt(stmt.body, false);
      this.currentScope = prev;
      return;
    }

    if (stmt instanceof TryCatchStmt) {
      const prev = this.currentScope;
      this.currentScope = new Scope(this.nextScopeId++, prev);
      this.walkStatementList(stmt.tryBlock, false);
      this.currentScope = prev;

      const catchScope = new Scope(this.nextScopeId++, prev);
      this.currentScope = catchScope;
      if (stmt.catchParam) {
        const tok: Token = stmt.catchParamToken ?? {
          type: "IDENTIFIER" as Token["type"],
          lexeme: stmt.catchParam,
          literal: null,
          line: stmt.catchLine ?? 1,
          column: 1,
        };
        this.declare(catchScope, tok, "catch", false);
      }
      this.walkStatementList(stmt.catchBlock, false);
      this.currentScope = prev;
    }
  }

  private walkExpr(expr: Expr): void {
    if (expr instanceof Literal) return;

    if (expr instanceof Variable) {
      this.markUsed(expr.name.lexeme);
      return;
    }

    if (expr instanceof Assign) {
      if (expr.compoundOp && expr.compoundRhs) {
        this.markUsed(expr.name.lexeme);
        this.walkExpr(expr.compoundRhs);
      } else {
        this.walkExpr(expr.value);
      }
      return;
    }

    if (expr instanceof SetIndex) {
      let cur: Expr = expr.target;
      while (cur instanceof IndexExpr) {
        this.walkExpr(cur.index);
        cur = cur.object;
      }
      if (cur instanceof Variable) {
        if (expr.operator) this.markUsed(cur.name.lexeme);
      } else {
        this.walkExpr(cur);
      }
      this.walkExpr(expr.value);
      return;
    }

    if (expr instanceof Binary) {
      this.walkExpr(expr.left);
      this.walkExpr(expr.right);
      return;
    }

    if (expr instanceof Unary) {
      this.walkExpr(expr.right);
      return;
    }

    if (expr instanceof Grouping) {
      this.walkExpr(expr.expression);
      return;
    }

    if (expr instanceof TernaryExpr) {
      this.walkExpr(expr.condition);
      this.walkExpr(expr.thenBranch);
      this.walkExpr(expr.elseBranch);
      return;
    }

    if (expr instanceof ArrayExpr) {
      for (const el of expr.elements) this.walkExpr(el);
      return;
    }

    if (expr instanceof ObjectExpr) {
      for (const prop of expr.properties) this.walkExpr(prop.value);
      return;
    }

    if (expr instanceof TemplateLiteralExpr) {
      for (const p of expr.parts) this.walkExpr(p);
      return;
    }

    if (expr instanceof IndexExpr) {
      this.walkExpr(expr.object);
      this.walkExpr(expr.index);
      return;
    }

    if (expr instanceof FunctionExpr) {
      const prev = this.currentScope;
      let selfSym: SymbolBinding | null = null;
      if (expr.name) {
        const nameScope = new Scope(this.nextScopeId++, prev);
        selfSym = this.declare(nameScope, expr.name, "const", false, expr.params.length);
        this.currentScope = nameScope;
      }
      const fnScope = new Scope(this.nextScopeId++, this.currentScope, true, selfSym);
      this.currentScope = fnScope;
      if (selfSym) this.currentFunctionOwners.add(selfSym);
      for (const p of expr.params) {
        this.declare(fnScope, p, "param", false);
      }
      this.walkStatementList(expr.body, false);
      if (selfSym) this.currentFunctionOwners.delete(selfSym);
      this.currentScope = prev;
      return;
    }

    if (expr instanceof Call) {
      if (expr.callee instanceof Variable) {
        const name = expr.callee.name.lexeme;
        const sym = this.markUsed(name);
        if (sym) {
          if (sym.kind === "function" && typeof sym.arity === "number" && expr.arguments.length !== sym.arity) {
            this.addDiag({
              rule: "wrong-arity",
              severity: "error",
              message: `Function '${name}' expects ${sym.arity} argument${sym.arity === 1 ? "" : "s"} but got ${expr.arguments.length}.`,
              line: expr.callee.name.line,
              column: expr.callee.name.column ?? 1,
              endColumn: expr.callee.name.endColumn,
            });
          }
        } else {
          const hostFn = this.registryMap.get(name);
          if (!hostFn) {
            this.addDiag({
              rule: "no-unknown-host-call",
              severity: "error",
              message: `Unknown host call or function '${name}'.`,
              line: expr.callee.name.line,
              column: expr.callee.name.column ?? 1,
              endColumn: expr.callee.name.endColumn,
            });
          } else {
            const arityMsg = arityError(hostFn, expr.arguments.length);
            if (arityMsg) {
              this.addDiag({
                rule: "wrong-arity",
                severity: "error",
                message: arityMsg,
                line: expr.callee.name.line,
                column: expr.callee.name.column ?? 1,
                endColumn: expr.callee.name.endColumn,
              });
            }
            if (hostFn.deprecated) {
              this.addDiag({
                rule: "deprecated-host-call",
                severity: "warning",
                message: `${hostFn.name} is deprecated: ${hostFn.deprecated}`,
                line: expr.callee.name.line,
                column: expr.callee.name.column ?? 1,
                endColumn: expr.callee.name.endColumn,
              });
            }
            if (hostFn.provider === "host" && hostFn.capability && this.manifestScopes !== null) {
              if (!this.manifestScopes.has(hostFn.capability)) {
                this.addDiag({
                  rule: "missing-capability",
                  severity: "error",
                  message: `'${hostFn.name}' requires capability '${hostFn.capability}', which is not listed in AppManifest.json permissions.scopes.`,
                  line: expr.callee.name.line,
                  column: expr.callee.name.column ?? 1,
                  endColumn: expr.callee.name.endColumn,
                });
              }
            }
          }

          // registerHandler("rpcName", "fnName") marks top-level fnName as used.
          if (name === "registerHandler" && expr.arguments.length >= 2) {
            const target = expr.arguments[1];
            if (target instanceof Literal && typeof target.value === "string") {
              const targetSym = this.rootScope.lookup(target.value);
              if (targetSym) targetSym.used = true;
            }
          }
        }
      } else {
        this.walkExpr(expr.callee);
      }

      for (const arg of expr.arguments) {
        this.walkExpr(arg);
      }
    }
  }
}

function resolveManifestScopes(opts: LintOptions): Set<string> | null {
  if (opts.manifest !== undefined) {
    return opts.manifest === null ? null : extractManifestScopes(opts.manifest);
  }
  if (opts.manifestPath) {
    const parsed = JSON.parse(readFileSync(opts.manifestPath, "utf8")) as Partial<AppManifestLike>;
    return extractManifestScopes(parsed);
  }
  if (opts.filePath) {
    const found = findManifestForFile(opts.filePath);
    if (found) return extractManifestScopes(found.manifest);
  }
  return null;
}

/** Lint a PulsarScript source string and return structured diagnostics (DX-02). */
export function lintPulsarScript(source: string, opts: LintOptions = {}): LintDiagnostic[] {
  let tokens: Token[];
  try {
    tokens = new Lexer(source).scanTokens();
  } catch (err: unknown) {
    if (err instanceof ParseError) {
      return [
        {
          rule: "syntax-error",
          severity: "error",
          message: err.message,
          line: err.token?.line ?? 1,
          column: err.token?.column ?? 1,
          endColumn: err.token?.endColumn,
          file: opts.filePath,
        },
      ];
    }
    throw err;
  }

  let statements: Stmt[];
  try {
    statements = new Parser(tokens).parse();
  } catch (err: unknown) {
    if (err instanceof ParseError) {
      const list = err.errors && err.errors.length > 0 ? err.errors : [err];
      return list.map((e) => ({
        rule: "syntax-error",
        severity: "error" as const,
        message: e.message,
        line: e.token?.line ?? 1,
        column: e.token?.column ?? 1,
        endColumn: e.token?.endColumn,
        file: opts.filePath,
      }));
    }
    throw err;
  }

  return new LinterEngine(opts).lint(statements);
}

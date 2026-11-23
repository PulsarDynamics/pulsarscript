import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { Lexer } from "./Lexer";
import { Parser } from "./Parser";
import { SemanticError } from "./SemanticAnalyzer";
import { Assign } from "./classes/Assign";
import { Binary } from "./classes/Binary";
import { BlockStmt } from "./classes/BlockStmt";
import { BreakStmt } from "./classes/BreakStmt";
import { Call } from "./classes/Call";
import { ExpressionStmt } from "./classes/ExpressionStmt";
import { ExportStmt } from "./classes/ExportStmt";
import { ForOfStmt } from "./classes/ForOfStmt";
import { ForStmt } from "./classes/ForStmt";
import { FunctionExpr } from "./classes/FunctionExpr";
import { FunctionStmt } from "./classes/FunctionStmt";
import { Grouping } from "./classes/Grouping";
import { IfStmt } from "./classes/IfStmt";
import { ImportStmt } from "./classes/ImportStmt";
import { IndexExpr } from "./classes/IndexExpr";
import { PrintStmt } from "./classes/PrintStmt";
import { ReturnStmt } from "./classes/ReturnStmt";
import { SetIndex } from "./classes/SetIndex";
import { TemplateLiteralExpr } from "./classes/TemplateLiteralExpr";
import { TernaryExpr } from "./classes/TernaryExpr";
import { TryCatchStmt } from "./classes/TryCatchStmt";
import { Unary } from "./classes/Unary";
import { VarStmt } from "./classes/VarStmt";
import { Variable } from "./classes/Variable";
import { WhileStmt } from "./classes/WhileStmt";
import { ArrayExpr } from "./classes/ArrayExpr";
import { ObjectExpr } from "./classes/ObjectExpr";
import type { Expr } from "./interfaces/Expr";
import type { Stmt } from "./interfaces/Stmt";
import type { Token } from "./interfaces/Token";

export interface LinkOptions {
  entrySource?: string;
  readFile?: (absPath: string) => string;
}

export interface LinkedProgram {
  statements: Stmt[];
  sources: string[];
}

interface ExportTarget {
  canonicalName: string;
  isConst: boolean;
}

interface TopBinding {
  canonicalName: string;
  isImportConst: boolean;
  token: Token;
}

interface ParsedModule {
  absPath: string;
  displayName: string;
  sourceIndex: number;
  statements: Stmt[];
  topBindings: Map<string, TopBinding>;
  exports: Map<string, ExportTarget>;
}

/**
 * Links an entry module and all transitive relative `import` statements into a single
 * flat AST + source map (LANG-12).
 */
export function linkModule(entryPath: string, opts: LinkOptions = {}): LinkedProgram {
  const entryAbs = resolve(entryPath);
  const entryDir = dirname(entryAbs);
  const readFn = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const visiting = new Set<string>();
  const loaded = new Map<string, ParsedModule>();
  const postOrderDeps: ParsedModule[] = [];
  let entryMod: ParsedModule | null = null;
  let nextDepIdx = 1;

  function resolveImportPath(importerAbs: string, specTok: Token): string {
    const raw = String(specTok.literal ?? "");
    if (!raw) {
      throw new SemanticError(specTok, "Import path cannot be empty.");
    }
    const base = resolve(dirname(importerAbs), raw);
    if (existsSync(base)) return base;
    if (!base.endsWith(".puls") && existsSync(base + ".puls")) return base + ".puls";
    throw new SemanticError(specTok, `Cannot find imported module '${raw}'.`);
  }

  function load(absPath: string, viaToken: Token | null): ParsedModule {
    const existing = loaded.get(absPath);
    if (existing) return existing;

    let src: string;
    if (absPath === entryAbs && opts.entrySource !== undefined) {
      src = opts.entrySource;
    } else {
      try {
        src = readFn(absPath);
      } catch {
        const errTok = viaToken ?? ({ line: 1, column: 1, lexeme: absPath } as Token);
        throw new SemanticError(errTok, `Cannot read module '${absPath}'.`);
      }
    }

    const tokens = new Lexer(src).scanTokens();
    const statements = new Parser(tokens).parse();

    const isEntry = absPath === entryAbs;
    const displayName = isEntry
      ? basename(entryAbs)
      : relative(entryDir, absPath).replace(/\\/g, "/");
    const mod: ParsedModule = {
      absPath,
      displayName,
      sourceIndex: isEntry ? 0 : -1,
      statements,
      topBindings: new Map(),
      exports: new Map(),
    };

    visiting.add(absPath);
    const deps: { stmt: ImportStmt; target: ParsedModule }[] = [];
    for (const stmt of statements) {
      assertNoNestedModuleStmts(stmt, false);
      if (stmt instanceof ImportStmt) {
        const depAbs = resolveImportPath(absPath, stmt.source);
        if (visiting.has(depAbs)) {
          throw new SemanticError(stmt.keyword, `Cyclic import involving '${stmt.source.literal}'.`);
        }
        const target = load(depAbs, stmt.source);
        deps.push({ stmt, target });
      }
    }
    visiting.delete(absPath);

    if (!isEntry) {
      mod.sourceIndex = nextDepIdx++;
    }

    const mangle = (name: string): string =>
      mod.sourceIndex === 0 ? name : `__m${mod.sourceIndex}$${name}`;

    // 1. Collect imported bindings (dependencies are already loaded & have exports resolved).
    for (const { stmt, target } of deps) {
      for (const spec of stmt.specifiers) {
        const exp = target.exports.get(spec.imported.lexeme);
        if (!exp) {
          throw new SemanticError(
            spec.imported,
            `Module '${stmt.source.literal}' does not export '${spec.imported.lexeme}'.`
          );
        }
        if (mod.topBindings.has(spec.local.lexeme)) {
          throw new SemanticError(
            spec.local,
            `Identifier '${spec.local.lexeme}' has already been declared.`
          );
        }
        mod.topBindings.set(spec.local.lexeme, {
          canonicalName: exp.canonicalName,
          isImportConst: true,
          token: spec.local,
        });
      }
    }

    // 2. Collect top-level own declarations (`var`, `const`, `function`, and exported decls).
    for (const raw of statements) {
      const decl = raw instanceof ExportStmt && raw.declaration ? raw.declaration : raw;
      if (decl instanceof VarStmt) {
        const name = decl.name.lexeme;
        if (mod.topBindings.has(name)) {
          throw new SemanticError(decl.name, `Identifier '${name}' has already been declared.`);
        }
        const canonicalName = mangle(name);
        mod.topBindings.set(name, {
          canonicalName,
          isImportConst: decl.isConst,
          token: decl.name,
        });
        if (raw instanceof ExportStmt) {
          if (mod.exports.has(name)) {
            throw new SemanticError(decl.name, `Duplicate export '${name}'.`);
          }
          mod.exports.set(name, { canonicalName, isConst: decl.isConst });
        }
      } else if (decl instanceof FunctionStmt) {
        const name = decl.name.lexeme;
        if (mod.topBindings.has(name)) {
          throw new SemanticError(decl.name, `Identifier '${name}' has already been declared.`);
        }
        const canonicalName = mangle(name);
        mod.topBindings.set(name, {
          canonicalName,
          isImportConst: false,
          token: decl.name,
        });
        if (raw instanceof ExportStmt) {
          if (mod.exports.has(name)) {
            throw new SemanticError(decl.name, `Duplicate export '${name}'.`);
          }
          mod.exports.set(name, { canonicalName, isConst: false });
        }
      }
    }

    // 3. Collect explicit `export { a, b as c };` statements.
    for (const stmt of statements) {
      if (stmt instanceof ExportStmt && stmt.specifiers) {
        for (const spec of stmt.specifiers) {
          const binding = mod.topBindings.get(spec.local.lexeme);
          if (!binding) {
            throw new SemanticError(
              spec.local,
              `Undefined exported symbol '${spec.local.lexeme}'.`
            );
          }
          const exportName = spec.exported.lexeme;
          if (mod.exports.has(exportName)) {
            throw new SemanticError(spec.exported, `Duplicate export '${exportName}'.`);
          }
          mod.exports.set(exportName, {
            canonicalName: binding.canonicalName,
            isConst: binding.isImportConst,
          });
        }
      }
    }

    loaded.set(absPath, mod);
    if (isEntry) {
      entryMod = mod;
    } else {
      postOrderDeps.push(mod);
    }
    return mod;
  }

  load(entryAbs, null);
  const modulesInInitOrder = [...postOrderDeps, entryMod!];
  const sources: string[] = [entryMod!.displayName];
  for (const dep of postOrderDeps) {
    sources[dep.sourceIndex] = dep.displayName;
  }

  const allStatements: Stmt[] = [];
  for (const mod of modulesInInitOrder) {
    const rewritten = rewriteModuleStatements(mod);
    allStatements.push(...rewritten);
  }

  return { statements: allStatements, sources };
}

function assertNoNestedModuleStmts(stmt: Stmt, insideNested: boolean): void {
  if (stmt instanceof ImportStmt) {
    if (insideNested) {
      throw new SemanticError(stmt.keyword, "'import' is only allowed at the top level.");
    }
    return;
  }
  if (stmt instanceof ExportStmt) {
    if (insideNested) {
      throw new SemanticError(stmt.keyword, "'export' is only allowed at the top level.");
    }
    if (stmt.declaration) assertNoNestedModuleStmts(stmt.declaration, false);
    return;
  }
  if (stmt instanceof BlockStmt) {
    for (const s of stmt.statements) assertNoNestedModuleStmts(s, true);
  } else if (stmt instanceof IfStmt) {
    assertNoNestedModuleStmts(stmt.thenBranch, true);
    if (stmt.elseBranch) assertNoNestedModuleStmts(stmt.elseBranch, true);
  } else if (stmt instanceof WhileStmt) {
    assertNoNestedModuleStmts(stmt.body, true);
  } else if (stmt instanceof ForStmt) {
    if (stmt.initializer) assertNoNestedModuleStmts(stmt.initializer, true);
    assertNoNestedModuleStmts(stmt.body, true);
  } else if (stmt instanceof ForOfStmt) {
    assertNoNestedModuleStmts(stmt.body, true);
  } else if (stmt instanceof FunctionStmt) {
    for (const s of stmt.body) assertNoNestedModuleStmts(s, true);
  } else if (stmt instanceof TryCatchStmt) {
    for (const s of stmt.tryBlock) assertNoNestedModuleStmts(s, true);
    for (const s of stmt.catchBlock) assertNoNestedModuleStmts(s, true);
  }
}

function rewriteTokenName(tok: Token, newName: string): Token {
  return { ...tok, lexeme: newName };
}

function rootTargetVariable(expr: Expr): Variable | null {
  let cur: Expr = expr;
  while (cur instanceof IndexExpr) {
    cur = cur.object;
  }
  return cur instanceof Variable ? cur : null;
}

function rewriteModuleStatements(mod: ParsedModule): Stmt[] {
  const scopes: Set<string>[] = [];

  const isShadowed = (name: string): boolean => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return true;
    }
    return false;
  };

  const resolveBinding = (name: string): TopBinding | undefined => {
    if (isShadowed(name)) return undefined;
    return mod.topBindings.get(name);
  };

  const rewriteExpr = (expr: Expr): void => {
    if (expr instanceof Variable) {
      const b = resolveBinding(expr.name.lexeme);
      if (b) expr.name = rewriteTokenName(expr.name, b.canonicalName);
      return;
    }
    if (expr instanceof Assign) {
      rewriteExpr(expr.value);
      const b = resolveBinding(expr.name.lexeme);
      if (b) {
        if (b.isImportConst) {
          throw new SemanticError(expr.name, `Cannot assign to constant '${expr.name.lexeme}'.`);
        }
        expr.name = rewriteTokenName(expr.name, b.canonicalName);
      }
      return;
    }
    if (expr instanceof SetIndex) {
      const rootVar = rootTargetVariable(expr.target);
      if (rootVar) {
        const b = resolveBinding(rootVar.name.lexeme);
        if (b && b.isImportConst) {
          throw new SemanticError(rootVar.name, `Cannot assign to constant '${rootVar.name.lexeme}'.`);
        }
      }
      rewriteExpr(expr.target);
      rewriteExpr(expr.value);
      return;
    }
    if (expr instanceof Binary) {
      rewriteExpr(expr.left);
      rewriteExpr(expr.right);
      return;
    }
    if (expr instanceof Unary) {
      rewriteExpr(expr.right);
      return;
    }
    if (expr instanceof Grouping) {
      rewriteExpr(expr.expression);
      return;
    }
    if (expr instanceof TernaryExpr) {
      rewriteExpr(expr.condition);
      rewriteExpr(expr.thenBranch);
      rewriteExpr(expr.elseBranch);
      return;
    }
    if (expr instanceof Call) {
      rewriteExpr(expr.callee);
      for (const a of expr.arguments) rewriteExpr(a);
      return;
    }
    if (expr instanceof IndexExpr) {
      rewriteExpr(expr.object);
      rewriteExpr(expr.index);
      return;
    }
    if (expr instanceof ArrayExpr) {
      for (const el of expr.elements) rewriteExpr(el);
      return;
    }
    if (expr instanceof ObjectExpr) {
      for (const prop of expr.properties) rewriteExpr(prop.value);
      return;
    }
    if (expr instanceof TemplateLiteralExpr) {
      for (const ex of expr.parts) rewriteExpr(ex);
      return;
    }
    if (expr instanceof FunctionExpr) {
      (expr as any).sourceIndex = mod.sourceIndex;
      const fnScope = new Set<string>();
      if (expr.name) fnScope.add(expr.name.lexeme);
      for (const p of expr.params) fnScope.add(p.lexeme);
      scopes.push(fnScope);
      for (const s of expr.body) rewriteStmt(s, false);
      scopes.pop();
    }
  };

  const rewriteStmt = (stmt: Stmt, isTopLevel: boolean): void => {
    (stmt as any).sourceIndex = mod.sourceIndex;
    if (stmt instanceof ExpressionStmt) {
      rewriteExpr(stmt.expression);
    } else if (stmt instanceof PrintStmt) {
      rewriteExpr(stmt.expression);
    } else if (stmt instanceof ReturnStmt) {
      if (stmt.value) rewriteExpr(stmt.value);
    } else if (stmt instanceof VarStmt) {
      if (stmt.initializer) rewriteExpr(stmt.initializer);
      if (isTopLevel) {
        const b = mod.topBindings.get(stmt.name.lexeme);
        if (b) stmt.name = rewriteTokenName(stmt.name, b.canonicalName);
      } else {
        scopes[scopes.length - 1].add(stmt.name.lexeme);
      }
    } else if (stmt instanceof FunctionStmt) {
      if (isTopLevel) {
        const b = mod.topBindings.get(stmt.name.lexeme);
        if (b) stmt.name = rewriteTokenName(stmt.name, b.canonicalName);
      } else {
        scopes[scopes.length - 1].add(stmt.name.lexeme);
      }
      const fnScope = new Set<string>(stmt.params.map((p) => p.lexeme));
      scopes.push(fnScope);
      for (const s of stmt.body) rewriteStmt(s, false);
      scopes.pop();
    } else if (stmt instanceof BlockStmt) {
      scopes.push(new Set());
      for (const s of stmt.statements) rewriteStmt(s, false);
      scopes.pop();
    } else if (stmt instanceof IfStmt) {
      rewriteExpr(stmt.condition);
      rewriteStmt(stmt.thenBranch, false);
      if (stmt.elseBranch) rewriteStmt(stmt.elseBranch, false);
    } else if (stmt instanceof WhileStmt) {
      rewriteExpr(stmt.condition);
      rewriteStmt(stmt.body, false);
    } else if (stmt instanceof ForStmt) {
      scopes.push(new Set());
      if (stmt.initializer) rewriteStmt(stmt.initializer, false);
      if (stmt.condition) rewriteExpr(stmt.condition);
      if (stmt.increment) rewriteExpr(stmt.increment);
      rewriteStmt(stmt.body, false);
      scopes.pop();
    } else if (stmt instanceof ForOfStmt) {
      rewriteExpr(stmt.iterable);
      scopes.push(new Set([stmt.name.lexeme]));
      rewriteStmt(stmt.body, false);
      scopes.pop();
    } else if (stmt instanceof TryCatchStmt) {
      scopes.push(new Set());
      for (const s of stmt.tryBlock) rewriteStmt(s, false);
      scopes.pop();
      const catchScope = new Set<string>();
      if (stmt.catchParam) catchScope.add(stmt.catchParam);
      scopes.push(catchScope);
      for (const s of stmt.catchBlock) rewriteStmt(s, false);
      scopes.pop();
    }
  };

  const out: Stmt[] = [];
  for (const raw of mod.statements) {
    if (raw instanceof ImportStmt) continue;
    if (raw instanceof ExportStmt) {
      if (!raw.declaration) continue;
      rewriteStmt(raw.declaration, true);
      out.push(raw.declaration);
      continue;
    }
    rewriteStmt(raw, true);
    out.push(raw);
  }
  return out;
}

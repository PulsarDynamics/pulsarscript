import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_FUNCTIONS, lookupHostFunction, type HostFunction } from "../HostApi";
import { Lexer } from "../Lexer";
import { ParseError, Parser } from "../Parser";
import { SemanticAnalyzer, SemanticError } from "../SemanticAnalyzer";
import { TokenType } from "../enums/TokenType";
import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { Token } from "../interfaces/Token";
import { ArrayExpr } from "../classes/ArrayExpr";
import { Assign } from "../classes/Assign";
import { Binary } from "../classes/Binary";
import { BlockStmt } from "../classes/BlockStmt";
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
import { ObjectExpr } from "../classes/ObjectExpr";
import { PrintStmt } from "../classes/PrintStmt";
import { ReturnStmt } from "../classes/ReturnStmt";
import { SetIndex } from "../classes/SetIndex";
import { TemplateLiteralExpr } from "../classes/TemplateLiteralExpr";
import { TernaryExpr } from "../classes/TernaryExpr";
import { TryCatchStmt } from "../classes/TryCatchStmt";
import { Unary } from "../classes/Unary";
import { VarStmt } from "../classes/VarStmt";
import { WhileStmt } from "../classes/WhileStmt";
import { formatPulsarScript } from "../tools/formatter";
import { lintPulsarScript } from "../tools/linter";

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4;
  code?: string;
  source: string;
  message: string;
}

export interface LspCompletionItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: { kind: "markdown"; value: string };
  insertText?: string;
}

export interface LspHover {
  contents: { kind: "markdown"; value: string };
  range?: LspRange;
}

export interface LspSignatureHelp {
  signatures: {
    label: string;
    documentation?: { kind: "markdown"; value: string };
    parameters: { label: string; documentation?: string }[];
  }[];
  activeSignature: number;
  activeParameter: number;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

interface DeclaredSymbol {
  name: string;
  kind: "function" | "var" | "const" | "param" | "import" | "catch";
  range: LspRange;
  selectionRange: LspRange;
  params?: string[];
  importSource?: string;
  importedName?: string;
  scopeStartLine: number;
  scopeEndLine: number;
  exported?: boolean;
}

interface ParsedAnalysis {
  tokens: Token[];
  statements: Stmt[];
  symbols: DeclaredSymbol[];
  imports: { source: string; sourceToken: Token; specifiers: { imported: Token; local: Token }[] }[];
  exports: Map<string, DeclaredSymbol>;
}

const PULSARSCRIPT_KEYWORDS = [
  "var", "const", "function", "return", "if", "else", "while", "for", "of",
  "break", "continue", "print", "try", "catch", "true", "false", "nil",
  "import", "export", "from", "as",
];

export function uriToPath(uri: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return decodeURIComponent(uri.slice("file://".length));
    }
  }
  return uri;
}

export function pathToUri(absPath: string): string {
  return pathToFileURL(resolve(absPath)).toString();
}

function tokenToRange(tok: Token): LspRange {
  const line = Math.max(0, (tok.line ?? 1) - 1);
  const startChar = Math.max(0, (tok.column ?? 1) - 1);
  const len = Math.max(1, tok.lexeme?.length ?? 1);
  const endLine = Math.max(line, (tok.endLine ?? tok.line ?? 1) - 1);
  const endChar =
    tok.endColumn !== undefined && endLine === line
      ? Math.max(startChar + 1, tok.endColumn - 1)
      : startChar + len;
  return {
    start: { line, character: startChar },
    end: { line: endLine, character: endChar },
  };
}

function makeRange1Based(line: number, column: number, endColumn?: number): LspRange {
  const l = Math.max(0, line - 1);
  const c = Math.max(0, column - 1);
  const ec = endColumn !== undefined ? Math.max(c + 1, endColumn - 1) : c + 1;
  return { start: { line: l, character: c }, end: { line: l, character: ec } };
}

function formatHostSignature(fn: HostFunction): string {
  const params = fn.params
    .map((p) => {
      const prefix = p.variadic ? "..." : "";
      const opt = !p.variadic && p.optional ? "?" : "";
      return `${prefix}${p.name}${opt}: ${p.type}`;
    })
    .join(", ");
  return `${fn.name}(${params}): ${fn.returns}`;
}

function formatHostMarkdown(fn: HostFunction): string {
  const lines: string[] = [];
  lines.push("```pulsarscript");
  lines.push(formatHostSignature(fn));
  lines.push("```");
  lines.push("");
  lines.push(fn.doc);
  if (fn.provider === "host" && fn.capability) {
    lines.push("");
    lines.push(`**Provider:** \`host\` · **Required scope:** \`${fn.capability}\``);
  } else {
    lines.push("");
    lines.push("**Provider:** `core`");
  }
  if (fn.deprecated) {
    lines.push("");
    lines.push(`**Deprecated:** ${fn.deprecated}`);
  }
  if (fn.params.length > 0) {
    lines.push("");
    lines.push("**Parameters:**");
    for (const p of fn.params) {
      const qual = p.variadic ? " (variadic)" : p.optional ? " (optional)" : "";
      lines.push(`- \`${p.name}\`: \`${p.type}\`${qual}`);
    }
  }
  return lines.join("\n");
}

function safeLex(text: string): Token[] {
  try {
    return new Lexer(text).scanTokens();
  } catch {
    // Retry with synthetic string/comment terminator so mid-edit signature help & completion still work.
    for (const suffix of ['"', '`', '*/']) {
      try {
        return new Lexer(text + suffix).scanTokens();
      } catch {
        // continue
      }
    }
    return [];
  }
}

function parseProgramBestEffort(text: string): ParsedAnalysis {
  const tokens = safeLex(text);
  let statements: Stmt[] = [];
  if (tokens.length > 0) {
    try {
      statements = new Parser(tokens).parse();
    } catch {
      statements = [];
    }
  }

  const symbols: DeclaredSymbol[] = [];
  const imports: ParsedAnalysis["imports"] = [];
  const exports = new Map<string, DeclaredSymbol>();
  const totalLines = Math.max(1, text.split("\n").length);

  const collectStmt = (raw: Stmt, scopeStart: number, scopeEnd: number, isExported = false): void => {
    if (raw instanceof ImportStmt) {
      imports.push({
        source: String(raw.source.literal ?? ""),
        sourceToken: raw.source,
        specifiers: raw.specifiers,
      });
      for (const spec of raw.specifiers) {
        const sym: DeclaredSymbol = {
          name: spec.local.lexeme,
          kind: "import",
          range: tokenToRange(spec.local),
          selectionRange: tokenToRange(spec.local),
          importSource: String(raw.source.literal ?? ""),
          importedName: spec.imported.lexeme,
          scopeStartLine: 1,
          scopeEndLine: totalLines,
        };
        symbols.push(sym);
      }
      return;
    }

    if (raw instanceof ExportStmt) {
      if (raw.declaration) {
        collectStmt(raw.declaration, scopeStart, scopeEnd, true);
      } else if (raw.specifiers) {
        for (const spec of raw.specifiers) {
          const target = symbols.find((s) => s.name === spec.local.lexeme && s.scopeStartLine === 1);
          if (target) {
            target.exported = true;
            exports.set(spec.exported.lexeme, target);
          }
        }
      }
      return;
    }

    if (raw instanceof VarStmt) {
      const r = tokenToRange(raw.name);
      let params: string[] | undefined;
      if (raw.initializer instanceof FunctionExpr) {
        params = raw.initializer.params.map((p) => p.lexeme);
      }
      const sym: DeclaredSymbol = {
        name: raw.name.lexeme,
        kind: raw.isConst ? "const" : "var",
        range: r,
        selectionRange: r,
        params,
        scopeStartLine: scopeStart,
        scopeEndLine: scopeEnd,
        exported: isExported,
      };
      symbols.push(sym);
      if (isExported) exports.set(sym.name, sym);
      if (raw.initializer) collectExpr(raw.initializer);
      return;
    }

    if (raw instanceof FunctionStmt) {
      const sel = tokenToRange(raw.name);
      const fnStart = raw.name.line;
      const fnEnd = raw.endLine ?? scopeEnd;
      const fullRange: LspRange = {
        start: sel.start,
        end: { line: Math.max(sel.start.line, fnEnd - 1), character: 1 },
      };
      const sym: DeclaredSymbol = {
        name: raw.name.lexeme,
        kind: "function",
        range: fullRange,
        selectionRange: sel,
        params: raw.params.map((p) => p.lexeme),
        scopeStartLine: scopeStart,
        scopeEndLine: scopeEnd,
        exported: isExported,
      };
      symbols.push(sym);
      if (isExported) exports.set(sym.name, sym);
      for (const p of raw.params) {
        const pr = tokenToRange(p);
        symbols.push({
          name: p.lexeme,
          kind: "param",
          range: pr,
          selectionRange: pr,
          scopeStartLine: fnStart,
          scopeEndLine: fnEnd,
        });
      }
      for (const s of raw.body) collectStmt(s, fnStart, fnEnd);
      return;
    }

    if (raw instanceof BlockStmt) {
      const bStart = raw.line ?? scopeStart;
      const bEnd = raw.endLine ?? scopeEnd;
      for (const s of raw.statements) collectStmt(s, bStart, bEnd);
      return;
    }

    if (raw instanceof IfStmt) {
      collectExpr(raw.condition);
      collectStmt(raw.thenBranch, scopeStart, scopeEnd);
      if (raw.elseBranch) collectStmt(raw.elseBranch, scopeStart, scopeEnd);
      return;
    }

    if (raw instanceof WhileStmt) {
      collectExpr(raw.condition);
      collectStmt(raw.body, scopeStart, scopeEnd);
      return;
    }

    if (raw instanceof ForStmt) {
      const fStart = (raw as unknown as { line?: number }).line ?? scopeStart;
      const fEnd = (raw.body as unknown as { endLine?: number }).endLine ?? scopeEnd;
      if (raw.initializer) collectStmt(raw.initializer, fStart, fEnd);
      if (raw.condition) collectExpr(raw.condition);
      if (raw.increment) collectExpr(raw.increment);
      collectStmt(raw.body, fStart, fEnd);
      return;
    }

    if (raw instanceof ForOfStmt) {
      collectExpr(raw.iterable);
      const fStart = raw.name.line;
      const fEnd = (raw.body as unknown as { endLine?: number }).endLine ?? scopeEnd;
      const r = tokenToRange(raw.name);
      symbols.push({
        name: raw.name.lexeme,
        kind: raw.isConst ? "const" : "var",
        range: r,
        selectionRange: r,
        scopeStartLine: fStart,
        scopeEndLine: fEnd,
      });
      collectStmt(raw.body, fStart, fEnd);
      return;
    }

    if (raw instanceof TryCatchStmt) {
      const tStart = (raw as unknown as { line?: number }).line ?? scopeStart;
      const tEnd = raw.tryEndLine ?? scopeEnd;
      for (const s of raw.tryBlock) collectStmt(s, tStart, tEnd);
      const cStart = raw.catchLine ?? tEnd;
      const cEnd = raw.endLine ?? scopeEnd;
      if (raw.catchParamToken) {
        const r = tokenToRange(raw.catchParamToken);
        symbols.push({
          name: raw.catchParamToken.lexeme,
          kind: "catch",
          range: r,
          selectionRange: r,
          scopeStartLine: cStart,
          scopeEndLine: cEnd,
        });
      }
      for (const s of raw.catchBlock) collectStmt(s, cStart, cEnd);
      return;
    }

    if (raw instanceof ExpressionStmt) collectExpr(raw.expression);
    else if (raw instanceof PrintStmt) collectExpr(raw.expression);
    else if (raw instanceof ReturnStmt && raw.value) collectExpr(raw.value);
  };

  const collectExpr = (e: Expr): void => {
    if (e instanceof Binary) {
      collectExpr(e.left);
      collectExpr(e.right);
    } else if (e instanceof Unary) {
      collectExpr(e.right);
    } else if (e instanceof Grouping) {
      collectExpr(e.expression);
    } else if (e instanceof Assign) {
      collectExpr(e.value);
    } else if (e instanceof SetIndex) {
      collectExpr(e.target);
      collectExpr(e.value);
    } else if (e instanceof TernaryExpr) {
      collectExpr(e.condition);
      collectExpr(e.thenBranch);
      collectExpr(e.elseBranch);
    } else if (e instanceof Call) {
      collectExpr(e.callee);
      for (const a of e.arguments) collectExpr(a);
    } else if (e instanceof IndexExpr) {
      collectExpr(e.object);
      collectExpr(e.index);
    } else if (e instanceof ArrayExpr) {
      for (const el of e.elements) collectExpr(el);
    } else if (e instanceof ObjectExpr) {
      for (const p of e.properties) collectExpr(p.value);
    } else if (e instanceof TemplateLiteralExpr) {
      for (const p of e.parts) collectExpr(p);
    } else if (e instanceof FunctionExpr) {
      const fnStart = e.keyword.line;
      const fnEnd = e.endLine ?? totalLines;
      if (e.name) {
        const nr = tokenToRange(e.name);
        symbols.push({
          name: e.name.lexeme,
          kind: "function",
          range: nr,
          selectionRange: nr,
          params: e.params.map((p) => p.lexeme),
          scopeStartLine: fnStart,
          scopeEndLine: fnEnd,
        });
      }
      for (const p of e.params) {
        const pr = tokenToRange(p);
        symbols.push({
          name: p.lexeme,
          kind: "param",
          range: pr,
          selectionRange: pr,
          scopeStartLine: fnStart,
          scopeEndLine: fnEnd,
        });
      }
      for (const s of e.body) collectStmt(s, fnStart, fnEnd);
    }
  };

  for (const s of statements) {
    collectStmt(s, 1, totalLines);
  }

  return { tokens, statements, symbols, imports, exports };
}

function findTokenAt(tokens: Token[], pos: LspPosition): Token | undefined {
  const line = pos.line + 1;
  const col = pos.character + 1;
  for (const tok of tokens) {
    if (tok.type === TokenType.EOF) continue;
    const tLine = tok.line;
    const startCol = tok.column ?? 1;
    const endCol = tok.endColumn ?? startCol + Math.max(1, tok.lexeme.length);
    if (tLine === line && col >= startCol && col <= endCol) {
      return tok;
    }
  }
  return undefined;
}

function visibleSymbolsAtLine(symbols: DeclaredSymbol[], line1Based: number): DeclaredSymbol[] {
  const byName = new Map<string, DeclaredSymbol>();
  // Prefer narrower (innermost) scope over outer scope.
  const ordered = symbols
    .filter((s) => line1Based >= s.scopeStartLine && line1Based <= s.scopeEndLine)
    .sort((a, b) => (b.scopeStartLine - a.scopeStartLine) || (a.scopeEndLine - b.scopeEndLine));
  for (const sym of ordered) {
    if (!byName.has(sym.name)) {
      byName.set(sym.name, sym);
    }
  }
  return [...byName.values()];
}

function resolveImportFile(currentUri: string, specPath: string): string | undefined {
  const filePath = uriToPath(currentUri);
  if (!filePath || !specPath) return undefined;
  const base = resolve(dirname(filePath), specPath);
  if (existsSync(base)) return base;
  if (!base.endsWith(".puls") && existsSync(base + ".puls")) return base + ".puls";
  return undefined;
}

/** Collect parser, semantic analyzer, and linter diagnostics for an open document. */
export function getDiagnostics(uri: string, text: string): LspDiagnostic[] {
  const filePath = uriToPath(uri);
  const diags: LspDiagnostic[] = [];
  const seenKeys = new Set<string>();

  const pushDiag = (d: LspDiagnostic) => {
    const key = `${d.range.start.line}:${d.range.start.character}:${d.message}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    diags.push(d);
  };

  let stmts: Stmt[] | null = null;
  try {
    const tokens = new Lexer(text).scanTokens();
    stmts = new Parser(tokens).parse();
  } catch (err: unknown) {
    if (err instanceof ParseError) {
      const list = err.errors && err.errors.length > 0 ? err.errors : [err];
      for (const e of list) {
        pushDiag({
          range: makeRange1Based(e.token?.line ?? 1, e.token?.column ?? 1, e.token?.endColumn),
          severity: 1,
          code: "syntax-error",
          source: "pulsarscript",
          message: e.message,
        });
      }
    }
  }

  if (stmts) {
    // Run semantic analyzer only on single-file programs without unresolved imports so
    // imported identifiers aren't falsely flagged before linking.
    const hasImports = stmts.some((s) => s instanceof ImportStmt);
    if (!hasImports) {
      const analyzer = new SemanticAnalyzer();
      try {
        analyzer.analyze(stmts);
      } catch (err: unknown) {
        if (err instanceof SemanticError) {
          pushDiag({
            range: makeRange1Based(err.token?.line ?? 1, err.token?.column ?? 1, err.token?.endColumn),
            severity: 1,
            code: "semantic-error",
            source: "pulsarscript",
            message: err.message,
          });
        }
      }
      for (const w of analyzer.warnings) {
        pushDiag({
          range: makeRange1Based(w.line, w.column ?? 1),
          severity: 2,
          code: "deprecated-host-call",
          source: "pulsarscript",
          message: w.message,
        });
      }
    }

    const lintDiags = lintPulsarScript(text, { filePath });
    for (const ld of lintDiags) {
      // Avoid duplicating identical semantic errors already added above.
      if (ld.rule === "syntax-error") continue;
      if (
        (ld.rule === "no-unknown-host-call" || ld.rule === "wrong-arity") &&
        diags.some((d) => d.range.start.line === Math.max(0, ld.line - 1) && d.severity === 1)
      ) {
        continue;
      }
      pushDiag({
        range: makeRange1Based(ld.line, ld.column, ld.endColumn),
        severity: ld.severity === "error" ? 1 : 2,
        code: ld.rule,
        source: "pulsarscript-lint",
        message: ld.message,
      });
    }
  }

  return diags;
}

/** Return typed completions from vm/hostapi.json, keywords, and in-scope declarations. */
export function getCompletions(uri: string, text: string, position: LspPosition): LspCompletionItem[] {
  const analysis = parseProgramBestEffort(text);
  const items: LspCompletionItem[] = [];
  const seen = new Set<string>();

  for (const sym of visibleSymbolsAtLine(analysis.symbols, position.line + 1)) {
    if (seen.has(sym.name)) continue;
    seen.add(sym.name);
    const kind = sym.kind === "function" ? 3 : sym.kind === "const" ? 21 : 6;
    const detail = sym.params
      ? `(${sym.params.join(", ")}) [${sym.kind}]`
      : sym.importSource
        ? `imported from "${sym.importSource}"`
        : sym.kind;
    items.push({ label: sym.name, kind, detail });
  }

  for (const fn of HOST_FUNCTIONS) {
    if (seen.has(fn.name)) continue;
    seen.add(fn.name);
    items.push({
      label: fn.name,
      kind: 3, // Function
      detail: `${formatHostSignature(fn)}${fn.capability ? ` [${fn.capability}]` : " [core]"}`,
      documentation: {
        kind: "markdown",
        value: formatHostMarkdown(fn),
      },
      insertText: fn.name,
    });
  }

  for (const kw of PULSARSCRIPT_KEYWORDS) {
    if (seen.has(kw)) continue;
    seen.add(kw);
    items.push({ label: kw, kind: 14, detail: "keyword" });
  }

  void uri;
  return items;
}

/** Return Markdown hover documentation for host calls or user-defined symbols. */
export function getHover(uri: string, text: string, position: LspPosition): LspHover | null {
  const analysis = parseProgramBestEffort(text);
  const tok = findTokenAt(analysis.tokens, position);
  if (!tok) return null;

  if (tok.type === TokenType.IDENTIFIER) {
    const visible = visibleSymbolsAtLine(analysis.symbols, position.line + 1);
    const sym = visible.find((s) => s.name === tok.lexeme);
    if (sym) {
      if (sym.kind === "import" && sym.importSource) {
        const targetAbs = resolveImportFile(uri, sym.importSource);
        if (targetAbs) {
          const targetAnalysis = parseProgramBestEffort(readFileSync(targetAbs, "utf8"));
          const exported = targetAnalysis.exports.get(sym.importedName ?? sym.name);
          if (exported) {
            const sig = exported.params
              ? `function ${exported.name}(${exported.params.join(", ")})`
              : `${exported.kind} ${exported.name}`;
            return {
              range: tokenToRange(tok),
              contents: {
                kind: "markdown",
                value: `\`\`\`pulsarscript\n${sig}\n\`\`\`\n\nImported from \`${sym.importSource}\` (line ${exported.selectionRange.start.line + 1})`,
              },
            };
          }
        }
      }

      const sig = sym.params
        ? `function ${sym.name}(${sym.params.join(", ")})`
        : `${sym.kind} ${sym.name}`;
      return {
        range: tokenToRange(tok),
        contents: {
          kind: "markdown",
          value: `\`\`\`pulsarscript\n${sig}\n\`\`\`\n\nDeclared at line ${sym.selectionRange.start.line + 1}`,
        },
      };
    }

    const hostFn = lookupHostFunction(tok.lexeme);
    if (hostFn) {
      return {
        range: tokenToRange(tok),
        contents: {
          kind: "markdown",
          value: formatHostMarkdown(hostFn),
        },
      };
    }
  }

  return null;
}

/** Resolve same-file and cross-file `import` definitions (DX-03 / LANG-12). */
export function getDefinition(uri: string, text: string, position: LspPosition): LspLocation | null {
  const analysis = parseProgramBestEffort(text);
  const tok = findTokenAt(analysis.tokens, position);
  if (!tok) return null;

  // 1. Clicking an import module path string (`import { x } from "./util.puls"`).
  if (tok.type === TokenType.STRING) {
    const imp = analysis.imports.find(
      (i) => i.sourceToken.line === tok.line && i.sourceToken.column === tok.column
    );
    if (imp) {
      const targetAbs = resolveImportFile(uri, imp.source);
      if (targetAbs) {
        return {
          uri: pathToUri(targetAbs),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        };
      }
    }
    return null;
  }

  if (tok.type !== TokenType.IDENTIFIER) return null;

  // 2. Clicking the imported original symbol name in `import { foo as bar } from "./mod"`.
  for (const imp of analysis.imports) {
    for (const spec of imp.specifiers) {
      if (
        (spec.imported.line === tok.line && spec.imported.column === tok.column) ||
        (spec.local.line === tok.line && spec.local.column === tok.column)
      ) {
        const targetAbs = resolveImportFile(uri, imp.source);
        if (targetAbs) {
          const targetAnalysis = parseProgramBestEffort(readFileSync(targetAbs, "utf8"));
          const expSym = targetAnalysis.exports.get(spec.imported.lexeme);
          if (expSym) {
            return { uri: pathToUri(targetAbs), range: expSym.selectionRange };
          }
          return {
            uri: pathToUri(targetAbs),
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          };
        }
      }
    }
  }

  // 3. Clicking a symbol reference anywhere in the file.
  const visible = visibleSymbolsAtLine(analysis.symbols, position.line + 1);
  const sym = visible.find((s) => s.name === tok.lexeme);
  if (!sym) return null;

  if (sym.kind === "import" && sym.importSource) {
    const targetAbs = resolveImportFile(uri, sym.importSource);
    if (targetAbs) {
      const targetAnalysis = parseProgramBestEffort(readFileSync(targetAbs, "utf8"));
      const expSym = targetAnalysis.exports.get(sym.importedName ?? sym.name);
      if (expSym) {
        return { uri: pathToUri(targetAbs), range: expSym.selectionRange };
      }
    }
  }

  return { uri, range: sym.selectionRange };
}

/** Provide active-parameter signature help for hostapi.json and user functions. */
export function getSignatureHelp(uri: string, text: string, position: LspPosition): LspSignatureHelp | null {
  const analysis = parseProgramBestEffort(text);
  const line = position.line + 1;
  const col = position.character + 1;

  // Find last token at or before cursor.
  let idx = -1;
  for (let i = 0; i < analysis.tokens.length; i++) {
    const t = analysis.tokens[i];
    if (t.type === TokenType.EOF) break;
    if (t.line < line || (t.line === line && (t.column ?? 1) <= col)) {
      idx = i;
    } else {
      break;
    }
  }
  if (idx < 0) return null;

  // Walk backward tracking balanced parentheses to find the enclosing call's `(`.
  let depth = 0;
  let commas = 0;
  let openParenIdx = -1;
  for (let i = idx; i >= 0; i--) {
    const t = analysis.tokens[i].type;
    if (t === TokenType.RIGHT_PAREN || t === TokenType.RIGHT_BRACKET || t === TokenType.RIGHT_BRACE) {
      depth++;
    } else if (t === TokenType.LEFT_PAREN) {
      if (depth === 0) {
        openParenIdx = i;
        break;
      }
      depth--;
    } else if (t === TokenType.LEFT_BRACKET || t === TokenType.LEFT_BRACE) {
      if (depth > 0) depth--;
    } else if (t === TokenType.COMMA && depth === 0) {
      commas++;
    }
  }

  if (openParenIdx <= 0) return null;
  const calleeTok = analysis.tokens[openParenIdx - 1];
  if (calleeTok.type !== TokenType.IDENTIFIER) return null;

  const hostFn = lookupHostFunction(calleeTok.lexeme);
  if (hostFn) {
    return {
      signatures: [
        {
          label: formatHostSignature(hostFn),
          documentation: { kind: "markdown", value: formatHostMarkdown(hostFn) },
          parameters: hostFn.params.map((p) => ({
            label: `${p.variadic ? "..." : ""}${p.name}${!p.variadic && p.optional ? "?" : ""}: ${p.type}`,
          })),
        },
      ],
      activeSignature: 0,
      activeParameter: hostFn.params.length > 0 ? Math.min(commas, hostFn.params.length - 1) : 0,
    };
  }

  const sym = visibleSymbolsAtLine(analysis.symbols, line).find(
    (s) => s.name === calleeTok.lexeme && s.params !== undefined
  );
  if (sym?.params) {
    return {
      signatures: [
        {
          label: `function ${sym.name}(${sym.params.join(", ")})`,
          parameters: sym.params.map((p) => ({ label: p })),
        },
      ],
      activeSignature: 0,
      activeParameter: sym.params.length > 0 ? Math.min(commas, sym.params.length - 1) : 0,
    };
  }

  void uri;
  return null;
}

/** Return top-level DocumentSymbols for the outline view. */
export function getDocumentSymbols(text: string): LspDocumentSymbol[] {
  const analysis = parseProgramBestEffort(text);
  const top = analysis.symbols.filter((s) => s.scopeStartLine === 1);
  return top.map((s) => ({
    name: s.name,
    detail: s.params ? `(${s.params.join(", ")})` : s.importSource ? `from "${s.importSource}"` : s.kind,
    kind: s.kind === "function" ? 12 : s.kind === "const" ? 14 : 13,
    range: s.range,
    selectionRange: s.selectionRange,
  }));
}

/** Return whole-document formatting edit using formatPulsarScript (DX-01). */
export function getFormattingEdits(text: string): LspTextEdit[] {
  try {
    const formatted = formatPulsarScript(text);
    if (formatted === text) return [];
    const lines = text.split("\n");
    const lastLine = Math.max(0, lines.length - 1);
    const lastChar = lines[lastLine]?.length ?? 0;
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lastLine, character: lastChar },
        },
        newText: formatted,
      },
    ];
  } catch {
    return [];
  }
}

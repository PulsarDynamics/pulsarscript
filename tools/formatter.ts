import { Lexer, type CommentToken } from "../Lexer";
import { Parser } from "../Parser";
import { TokenType } from "../enums/TokenType";
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
import { ObjectExpr, type ObjectProperty } from "../classes/ObjectExpr";
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

const KEYWORDS = new Set([
  "var", "const", "function", "return", "if", "else", "while", "for",
  "print", "try", "catch", "break", "continue", "true", "false", "nil",
  "import", "export",
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

function isValidBareIdentifier(name: string): boolean {
  return IDENT_RE.test(name) && !KEYWORDS.has(name);
}

function escapeDoubleQuoted(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const ch = s.slice(i, i + step);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += `\\u{${cp.toString(16)}}`;
    } else {
      out += ch;
    }
    i += step;
  }
  return out + '"';
}

function escapeTemplateContent(s: string, keepLiteralNewlines: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const ch = s.slice(i, i + step);
    if (ch === "`") out += "\\`";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "$" && s[i + 1] === "{") out += "\\$";
    else if (ch === "\n") out += keepLiteralNewlines ? "\n" : "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += `\\u{${cp.toString(16)}}`;
    } else {
      out += ch;
    }
    i += step;
  }
  return out;
}

function exprStartLine(e: Expr): number {
  const anyE = e as unknown as { line?: number; left?: Expr; target?: Expr; condition?: Expr; callee?: Expr; object?: Expr; name?: { line?: number }; operator?: { line?: number }; token?: { line?: number }; keyword?: { line?: number } };
  if (typeof anyE.line === "number" && anyE.line > 0) return anyE.line;
  if (e instanceof Binary) return exprStartLine(e.left);
  if (e instanceof Unary) return e.operator.line;
  if (e instanceof Assign) return e.name.line;
  if (e instanceof Variable) return e.name.line;
  if (e instanceof Call) return exprStartLine(e.callee);
  if (e instanceof IndexExpr) return exprStartLine(e.object);
  if (e instanceof SetIndex) return exprStartLine(e.target);
  if (e instanceof TernaryExpr) return exprStartLine(e.condition);
  if (e instanceof Grouping) return exprStartLine(e.expression);
  if (e instanceof FunctionExpr) return e.keyword.line;
  if (e instanceof TemplateLiteralExpr) return e.token.line;
  return 0;
}

function exprEndLine(e: Expr): number {
  if (e instanceof ArrayExpr && typeof e.endLine === "number") return e.endLine;
  if (e instanceof ObjectExpr && typeof e.endLine === "number") return e.endLine;
  if (e instanceof FunctionExpr && typeof e.endLine === "number") return e.endLine;
  if (e instanceof Binary) return exprEndLine(e.right) || exprStartLine(e);
  if (e instanceof Unary) return exprEndLine(e.right) || e.operator.line;
  if (e instanceof Assign) return exprEndLine(e.compoundRhs ?? e.value) || e.name.line;
  if (e instanceof SetIndex) return exprEndLine(e.value) || e.equals.line;
  if (e instanceof TernaryExpr) return exprEndLine(e.elseBranch) || e.question.line;
  if (e instanceof Call) return e.paren.line;
  if (e instanceof IndexExpr) return exprEndLine(e.index) || e.token.line;
  if (e instanceof Grouping) return exprEndLine(e.expression);
  if (e instanceof TemplateLiteralExpr) {
    const last = e.parts[e.parts.length - 1];
    return exprEndLine(last) || e.token.line;
  }
  return exprStartLine(e);
}

function stmtStartOffset(s: Stmt): number {
  const anyS = s as unknown as { startOffset?: number };
  if (typeof anyS.startOffset === "number") return anyS.startOffset;
  return Number.MAX_SAFE_INTEGER;
}

function stmtEndOffset(s: Stmt): number {
  const anyS = s as unknown as { endOffset?: number };
  if (typeof anyS.endOffset === "number") return anyS.endOffset;
  return 0;
}

function stmtStartLine(s: Stmt): number {
  const anyS = s as unknown as { line?: number };
  if (typeof anyS.line === "number" && anyS.line > 0) return anyS.line;
  if (s instanceof VarStmt) return s.name.line;
  if (s instanceof FunctionStmt) return s.name.line;
  if (s instanceof ReturnStmt || s instanceof BreakStmt || s instanceof ImportStmt || s instanceof ExportStmt) {
    return s.keyword.line;
  }
  if (s instanceof ForOfStmt) return s.name.line;
  if (s instanceof ExpressionStmt) return exprStartLine(s.expression);
  if (s instanceof PrintStmt) return exprStartLine(s.expression);
  return 1;
}

function stmtEndLine(s: Stmt): number {
  const anyS = s as unknown as { endLine?: number };
  if (s instanceof BlockStmt && typeof s.endLine === "number") return s.endLine;
  if (s instanceof FunctionStmt && typeof s.endLine === "number") return s.endLine;
  if (s instanceof TryCatchStmt && typeof s.endLine === "number") return s.endLine;
  if (s instanceof ExportStmt && s.declaration) return stmtEndLine(s.declaration);
  if (s instanceof IfStmt) {
    return s.elseBranch ? stmtEndLine(s.elseBranch) : stmtEndLine(s.thenBranch);
  }
  if (s instanceof WhileStmt) return stmtEndLine(s.body);
  if (s instanceof ForStmt) return stmtEndLine(s.body);
  if (s instanceof ForOfStmt) return stmtEndLine(s.body);
  if (typeof anyS.endLine === "number" && anyS.endLine > 0) return anyS.endLine;
  if (s instanceof ExpressionStmt) return exprEndLine(s.expression) || stmtStartLine(s);
  if (s instanceof PrintStmt) return exprEndLine(s.expression) || stmtStartLine(s);
  if (s instanceof ReturnStmt) return s.value ? exprEndLine(s.value) || s.keyword.line : s.keyword.line;
  if (s instanceof VarStmt) return s.initializer ? exprEndLine(s.initializer) || s.name.line : s.name.line;
  if (s instanceof ImportStmt) return s.source.line;
  return stmtStartLine(s);
}

class Formatter {
  private readonly comments: CommentToken[];
  private commentIdx = 0;

  constructor(comments: CommentToken[]) {
    this.comments = comments;
  }

  formatProgram(statements: Stmt[]): string {
    const lines = this.formatStatementList(statements, 0, Number.MAX_SAFE_INTEGER);
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (lines.length === 0) return "";
    return lines.join("\n") + "\n";
  }

  private indentStr(depth: number): string {
    return "  ".repeat(depth);
  }

  private peekComment(): CommentToken | undefined {
    return this.comments[this.commentIdx];
  }

  private consumeComment(): CommentToken {
    return this.comments[this.commentIdx++];
  }

  private emitCommentLines(lines: string[], c: CommentToken, depth: number): void {
    const pad = this.indentStr(depth);
    if (c.kind === "line") {
      lines.push(`${pad}${c.text}`);
      return;
    }
    const rawLines = c.text.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      if (i === 0) {
        lines.push(`${pad}${rawLines[i].trimEnd()}`);
      } else {
        lines.push(rawLines[i].trimEnd());
      }
    }
  }

  private formatStatementList(statements: Stmt[], depth: number, maxEndOffset: number): string[] {
    const lines: string[] = [];
    let prevSourceEndLine = 0;

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const sStartLine = stmtStartLine(stmt);
      const sEndLine = stmtEndLine(stmt);
      const sStartOff = stmtStartOffset(stmt);
      const sEndOff = stmtEndOffset(stmt);

      // Emit leading comments strictly before this statement's first token.
      while (this.peekComment() && this.peekComment()!.endOffset <= sStartOff && this.peekComment()!.endOffset <= maxEndOffset) {
        const c = this.consumeComment();
        if (prevSourceEndLine > 0 && c.line - prevSourceEndLine > 1 && lines[lines.length - 1] !== "") {
          lines.push("");
        }
        this.emitCommentLines(lines, c, depth);
        prevSourceEndLine = c.endLine;
      }

      if (prevSourceEndLine > 0 && sStartLine - prevSourceEndLine > 1 && lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }

      const stmtLines = this.formatStatement(stmt, depth);

      // Any comments still inside [sStartOff, sEndOff] (e.g. inside expression args) stay attached cleanly.
      while (this.peekComment() && this.peekComment()!.endOffset <= sEndOff && this.peekComment()!.endOffset <= maxEndOffset) {
        const c = this.consumeComment();
        if (c.kind === "line") {
          stmtLines.unshift(`${this.indentStr(depth)}${c.text}`);
        } else {
          const idx = Math.max(0, stmtLines.length - 1);
          stmtLines[idx] += ` ${c.text}`;
        }
      }

      // Attach trailing comment on sEndLine before the next statement and inside maxEndOffset.
      const nextStartOff = i + 1 < statements.length ? stmtStartOffset(statements[i + 1]) : maxEndOffset;
      while (
        this.peekComment() &&
        this.peekComment()!.line === sEndLine &&
        this.peekComment()!.endOffset <= nextStartOff &&
        this.peekComment()!.endOffset <= maxEndOffset
      ) {
        const c = this.consumeComment();
        if (stmtLines.length > 0) {
          stmtLines[stmtLines.length - 1] += ` ${c.text}`;
        }
      }

      lines.push(...stmtLines);
      prevSourceEndLine = Math.max(prevSourceEndLine, sEndLine);
    }

    // Trailing comments inside this block/program before closing brace/EOF.
    while (this.peekComment() && this.peekComment()!.endOffset <= maxEndOffset) {
      const c = this.consumeComment();
      if (prevSourceEndLine > 0 && c.line - prevSourceEndLine > 1 && lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      this.emitCommentLines(lines, c, depth);
      prevSourceEndLine = c.endLine;
    }

    return lines;
  }

  private formatBody(body: Stmt, depth: number, headerPrefix: string): string[] {
    if (body instanceof BlockStmt) {
      const maxEnd = typeof body.endOffset === "number" ? Math.max(0, body.endOffset - 1) : Number.MAX_SAFE_INTEGER;
      const inner = this.formatStatementList(body.statements, depth + 1, maxEnd);
      if (inner.length === 0) {
        return [`${headerPrefix} {}`];
      }
      return [`${headerPrefix} {`, ...inner, `${this.indentStr(depth)}}`];
    }
    const inner = this.formatStatement(body, depth + 1);
    return [`${headerPrefix} {`, ...inner, `${this.indentStr(depth)}}`];
  }

  private formatStatement(stmt: Stmt, depth: number): string[] {
    const pad = this.indentStr(depth);

    if (stmt instanceof ImportStmt) {
      const specs = stmt.specifiers.map((s) =>
        s.imported.lexeme === s.local.lexeme ? s.imported.lexeme : `${s.imported.lexeme} as ${s.local.lexeme}`
      );
      const pathStr = escapeDoubleQuoted(String(stmt.source.literal ?? ""));
      return [`${pad}import { ${specs.join(", ")} } from ${pathStr};`];
    }

    if (stmt instanceof ExportStmt) {
      if (stmt.declaration) {
        const inner = this.formatStatement(stmt.declaration, depth);
        inner[0] = `${pad}export ${inner[0].slice(pad.length)}`;
        return inner;
      }
      const specs = (stmt.specifiers ?? []).map((s) =>
        s.local.lexeme === s.exported.lexeme ? s.local.lexeme : `${s.local.lexeme} as ${s.exported.lexeme}`
      );
      return [`${pad}export { ${specs.join(", ")} };`];
    }

    if (stmt instanceof VarStmt) {
      const kw = stmt.isConst ? "const" : "var";
      if (stmt.initializer !== null) {
        return [`${pad}${kw} ${stmt.name.lexeme} = ${this.expr(stmt.initializer, depth)};`];
      }
      return [`${pad}${kw} ${stmt.name.lexeme};`];
    }

    if (stmt instanceof FunctionStmt) {
      const params = stmt.params.map((p) => p.lexeme).join(", ");
      const header = `${pad}function ${stmt.name.lexeme}(${params})`;
      const maxEnd = typeof stmt.endOffset === "number" ? Math.max(0, stmt.endOffset - 1) : Number.MAX_SAFE_INTEGER;
      const inner = this.formatStatementList(stmt.body, depth + 1, maxEnd);
      if (inner.length === 0) {
        return [`${header} {}`];
      }
      return [`${header} {`, ...inner, `${pad}}`];
    }

    if (stmt instanceof BlockStmt) {
      const maxEnd = typeof stmt.endOffset === "number" ? Math.max(0, stmt.endOffset - 1) : Number.MAX_SAFE_INTEGER;
      const inner = this.formatStatementList(stmt.statements, depth + 1, maxEnd);
      if (inner.length === 0) {
        return [`${pad}{}`];
      }
      return [`${pad}{`, ...inner, `${pad}}`];
    }

    if (stmt instanceof IfStmt) {
      return this.formatIfStmt(stmt, depth, pad);
    }

    if (stmt instanceof WhileStmt) {
      return this.formatBody(stmt.body, depth, `${pad}while (${this.expr(stmt.condition, depth)})`);
    }

    if (stmt instanceof ForStmt) {
      const init = this.formatForInitializer(stmt.initializer, depth);
      const cond = stmt.condition ? this.expr(stmt.condition, depth) : "";
      const inc = stmt.increment ? this.expr(stmt.increment, depth) : "";
      const parts = [init, cond ? ` ${cond}` : "", inc ? ` ${inc}` : ""];
      return this.formatBody(stmt.body, depth, `${pad}for (${parts.join(";")})`);
    }

    if (stmt instanceof ForOfStmt) {
      const kw = stmt.isConst ? "const" : "var";
      return this.formatBody(
        stmt.body,
        depth,
        `${pad}for (${kw} ${stmt.name.lexeme} of ${this.expr(stmt.iterable, depth)})`
      );
    }

    if (stmt instanceof TryCatchStmt) {
      const tryMaxEnd = typeof stmt.tryEndOffset === "number" ? Math.max(0, stmt.tryEndOffset - 1) : Number.MAX_SAFE_INTEGER;
      const catchMaxEnd = typeof stmt.endOffset === "number" ? Math.max(0, stmt.endOffset - 1) : Number.MAX_SAFE_INTEGER;
      const tryInner = this.formatStatementList(stmt.tryBlock, depth + 1, tryMaxEnd);
      const catchInner = this.formatStatementList(stmt.catchBlock, depth + 1, catchMaxEnd);
      const lines: string[] = [];
      if (tryInner.length === 0) {
        lines.push(`${pad}try {}`);
      } else {
        lines.push(`${pad}try {`, ...tryInner, `${pad}}`);
      }
      const catchHead = stmt.catchParam ? `catch (${stmt.catchParam})` : "catch";
      if (catchInner.length === 0) {
        lines[lines.length - 1] += ` ${catchHead} {}`;
      } else {
        lines[lines.length - 1] += ` ${catchHead} {`;
        lines.push(...catchInner, `${pad}}`);
      }
      return lines;
    }

    if (stmt instanceof ReturnStmt) {
      if (stmt.value !== null) {
        return [`${pad}return ${this.expr(stmt.value, depth)};`];
      }
      return [`${pad}return;`];
    }

    if (stmt instanceof BreakStmt) {
      return [`${pad}${stmt.isContinue ? "continue" : "break"};`];
    }

    if (stmt instanceof PrintStmt) {
      const inner = stmt.expression instanceof Grouping ? stmt.expression.expression : stmt.expression;
      return [`${pad}print(${this.expr(inner, depth)});`];
    }

    if (stmt instanceof ExpressionStmt) {
      return [`${pad}${this.expr(stmt.expression, depth)};`];
    }

    throw new Error(`Unsupported statement type in formatter: ${(stmt as object).constructor.name}`);
  }

  private formatIfStmt(stmt: IfStmt, depth: number, headerPrefix: string): string[] {
    const lines = this.formatBody(stmt.thenBranch, depth, `${headerPrefix}if (${this.expr(stmt.condition, depth)})`);
    if (!stmt.elseBranch) return lines;
    if (stmt.elseBranch instanceof IfStmt) {
      const elseLines = this.formatIfStmt(stmt.elseBranch, depth, "");
      lines[lines.length - 1] += ` else ${elseLines[0]}`;
      lines.push(...elseLines.slice(1));
      return lines;
    }
    const pad = this.indentStr(depth);
    if (stmt.elseBranch instanceof BlockStmt) {
      const maxEnd = typeof stmt.elseBranch.endOffset === "number" ? Math.max(0, stmt.elseBranch.endOffset - 1) : Number.MAX_SAFE_INTEGER;
      const inner = this.formatStatementList(stmt.elseBranch.statements, depth + 1, maxEnd);
      if (inner.length === 0) {
        lines[lines.length - 1] += " else {}";
      } else {
        lines[lines.length - 1] += " else {";
        lines.push(...inner, `${pad}}`);
      }
      return lines;
    }
    const inner = this.formatStatement(stmt.elseBranch, depth + 1);
    lines[lines.length - 1] += " else {";
    lines.push(...inner, `${pad}}`);
    return lines;
  }

  private formatForInitializer(init: Stmt | null, depth: number): string {
    if (!init) return "";
    if (init instanceof VarStmt) {
      const kw = init.isConst ? "const" : "var";
      return init.initializer !== null ? `${kw} ${init.name.lexeme} = ${this.expr(init.initializer, depth)}` : `${kw} ${init.name.lexeme}`;
    }
    if (init instanceof ExpressionStmt) {
      return this.expr(init.expression, depth);
    }
    throw new Error(`Unsupported for-loop initializer: ${(init as object).constructor.name}`);
  }

  private wrapIfNeeded(e: Expr, minPrec: number, depth: number): string {
    const s = this.expr(e, depth);
    if (e instanceof Binary) {
      const p = PRECEDENCE[e.operator.lexeme] ?? 0;
      if (p < minPrec) return `(${s})`;
      return s;
    }
    if (e instanceof TernaryExpr || e instanceof Assign || e instanceof SetIndex || e instanceof FunctionExpr) {
      return `(${s})`;
    }
    return s;
  }

  private wrapPostfixBase(e: Expr, depth: number): string {
    const s = this.expr(e, depth);
    if (
      e instanceof Binary ||
      e instanceof Unary ||
      e instanceof TernaryExpr ||
      e instanceof Assign ||
      e instanceof SetIndex ||
      e instanceof FunctionExpr
    ) {
      return `(${s})`;
    }
    return s;
  }

  private expr(e: Expr, depth: number): string {
    if (e instanceof Literal) {
      if (e.value === null) return "nil";
      if (typeof e.value === "boolean") return e.value ? "true" : "false";
      if (typeof e.value === "number") {
        if (e.raw !== undefined) return e.raw;
        return Object.is(e.value, -0) ? "-0" : String(e.value);
      }
      if (typeof e.value === "string") {
        if (e.isTemplate) {
          const keepNewlines = Boolean(e.raw?.includes("\n"));
          return "`" + escapeTemplateContent(e.value, keepNewlines) + "`";
        }
        return escapeDoubleQuoted(e.value);
      }
      return String(e.value);
    }

    if (e instanceof Variable) {
      return e.name.lexeme;
    }

    if (e instanceof Grouping) {
      return `(${this.expr(e.expression, depth)})`;
    }

    if (e instanceof Unary) {
      const inner = e.right;
      let rhs = this.expr(inner, depth);
      if (
        inner instanceof Binary ||
        inner instanceof TernaryExpr ||
        inner instanceof Assign ||
        inner instanceof SetIndex ||
        inner instanceof FunctionExpr
      ) {
        rhs = `(${rhs})`;
      } else if (e.operator.lexeme === "-" && inner instanceof Unary && inner.operator.lexeme === "-") {
        rhs = `(${rhs})`;
      }
      return `${e.operator.lexeme}${rhs}`;
    }

    if (e instanceof Binary) {
      const op = e.operator.lexeme;
      const p = PRECEDENCE[op] ?? 0;
      const left = this.wrapIfNeeded(e.left, p, depth);
      const right = this.wrapIfNeeded(e.right, p + 1, depth);
      return `${left} ${op} ${right}`;
    }

    if (e instanceof TernaryExpr) {
      const cond =
        e.condition instanceof TernaryExpr || e.condition instanceof Assign || e.condition instanceof SetIndex
          ? `(${this.expr(e.condition, depth)})`
          : this.expr(e.condition, depth);
      const thenBranch =
        e.thenBranch instanceof Assign || e.thenBranch instanceof SetIndex
          ? `(${this.expr(e.thenBranch, depth)})`
          : this.expr(e.thenBranch, depth);
      const elseBranch =
        e.elseBranch instanceof Assign || e.elseBranch instanceof SetIndex
          ? `(${this.expr(e.elseBranch, depth)})`
          : this.expr(e.elseBranch, depth);
      return `${cond} ? ${thenBranch} : ${elseBranch}`;
    }

    if (e instanceof Assign) {
      if (e.compoundOp && e.compoundRhs) {
        return `${e.name.lexeme} ${e.compoundOp} ${this.expr(e.compoundRhs, depth)}`;
      }
      return `${e.name.lexeme} = ${this.expr(e.value, depth)}`;
    }

    if (e instanceof IndexExpr) {
      const base = this.wrapPostfixBase(e.object, depth);
      if (e.member && e.index instanceof Literal && typeof e.index.value === "string" && isValidBareIdentifier(e.index.value)) {
        return `${base}.${e.index.value}`;
      }
      return `${base}[${this.expr(e.index, depth)}]`;
    }

    if (e instanceof SetIndex) {
      const op = e.operator ? `${e.operator.lexeme}=` : "=";
      return `${this.expr(e.target, depth)} ${op} ${this.expr(e.value, depth)}`;
    }

    if (e instanceof Call) {
      const callee = this.wrapPostfixBase(e.callee, depth);
      const args = e.arguments.map((a) => this.expr(a, depth));
      const single = `${callee}(${args.join(", ")})`;
      if (args.length > 1 && single.length > 100 && !single.includes("\n")) {
        const innerPad = this.indentStr(depth + 1);
        const closePad = this.indentStr(depth);
        return `${callee}(\n${innerPad}${args.join(`,\n${innerPad}`)}\n${closePad})`;
      }
      return single;
    }

    if (e instanceof ArrayExpr) {
      if (e.elements.length === 0) return "[]";
      const items = e.elements.map((el) => this.expr(el, depth));
      const single = `[${items.join(", ")}]`;
      const hasMulti = items.some((x) => x.includes("\n"));
      if (!hasMulti && single.length <= 80) {
        return single;
      }
      const nextItems = e.elements.map((el) => this.expr(el, depth + 1));
      const innerPad = this.indentStr(depth + 1);
      const closePad = this.indentStr(depth);
      return `[\n${innerPad}${nextItems.join(`,\n${innerPad}`)}\n${closePad}]`;
    }

    if (e instanceof ObjectExpr) {
      if (e.properties.length === 0) return "{}";
      const fmtProp = (p: ObjectProperty, d: number): string => {
        const k = isValidBareIdentifier(p.key) ? p.key : escapeDoubleQuoted(p.key);
        return `${k}: ${this.expr(p.value, d)}`;
      };
      const items = e.properties.map((p) => fmtProp(p, depth));
      const single = `{ ${items.join(", ")} }`;
      const hasMulti = items.some((x) => x.includes("\n"));
      if (!hasMulti && single.length <= 80) {
        return single;
      }
      const nextItems = e.properties.map((p) => fmtProp(p, depth + 1));
      const innerPad = this.indentStr(depth + 1);
      const closePad = this.indentStr(depth);
      return `{\n${innerPad}${nextItems.join(`,\n${innerPad}`)}\n${closePad}}`;
    }

    if (e instanceof TemplateLiteralExpr) {
      const keepNewlines = e.parts.some(
        (p, idx) => idx % 2 === 0 && p instanceof Literal && Boolean(p.raw?.includes("\n"))
      );
      let out = "`";
      for (let i = 0; i < e.parts.length; i++) {
        const part = e.parts[i];
        if (i % 2 === 0 && part instanceof Literal && typeof part.value === "string") {
          out += escapeTemplateContent(part.value, keepNewlines);
        } else {
          out += `\${${this.expr(part, depth)}}`;
        }
      }
      return out + "`";
    }

    if (e instanceof FunctionExpr) {
      const namePart = e.name ? ` ${e.name.lexeme}` : "";
      const params = e.params.map((p) => p.lexeme).join(", ");
      const maxEnd = typeof e.endOffset === "number" ? Math.max(0, e.endOffset - 1) : Number.MAX_SAFE_INTEGER;
      const inner = this.formatStatementList(e.body, depth + 1, maxEnd);
      if (inner.length === 0) {
        return `function${namePart}(${params}) {}`;
      }
      return `function${namePart}(${params}) {\n${inner.join("\n")}\n${this.indentStr(depth)}}`;
    }

    throw new Error(`Unsupported expression type in formatter: ${(e as object).constructor.name}`);
  }
}

/**
 * Format PulsarScript source code in canonical single-style formatting (DX-01).
 * Throws ParseError if the source cannot be lexed or parsed.
 */
export function formatPulsarScript(source: string): string {
  const lexer = new Lexer(source);
  const tokens = lexer.scanTokens();
  const parser = new Parser(tokens);
  const statements = parser.parse();
  const formatter = new Formatter(lexer.comments);
  return formatter.formatProgram(statements);
}

import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Stmt } from "../interfaces/Stmt";
import type { Token } from "../interfaces/Token";

export class FunctionExpr implements Expr {
  keyword: Token;
  name: Token | null;
  params: Token[];
  body: Stmt[];
  line?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;

  constructor(keyword: Token, name: Token | null, params: Token[], body: Stmt[], endLine?: number, endOffset?: number) {
    this.keyword = keyword;
    this.name = name;
    this.params = params;
    this.body = body;
    this.line = keyword.line;
    this.startOffset = keyword.startOffset;
    if (endLine !== undefined) this.endLine = endLine;
    if (endOffset !== undefined) this.endOffset = endOffset;
  }

  accept<R>(visitor: ExprVisitor<R>): R {
    return visitor.visitFunctionExpr(this);
  }
}

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

  constructor(keyword: Token, name: Token | null, params: Token[], body: Stmt[]) {
    this.keyword = keyword;
    this.name = name;
    this.params = params;
    this.body = body;
    this.line = keyword.line;
  }

  accept<R>(visitor: ExprVisitor<R>): R {
    return visitor.visitFunctionExpr(this);
  }
}

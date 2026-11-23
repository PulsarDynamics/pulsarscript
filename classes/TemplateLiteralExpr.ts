import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class TemplateLiteralExpr implements Expr {
  parts: Expr[];
  token: Token;
  line?: number;

  constructor(parts: Expr[], token: Token) {
    this.parts = parts;
    this.token = token;
    this.line = token.line;
  }

  accept<R>(visitor: ExprVisitor<R>): R {
    return visitor.visitTemplateLiteralExpr(this);
  }
}

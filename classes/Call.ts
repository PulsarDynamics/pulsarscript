import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class Call implements Expr {
    callee: Expr;
    paren: Token;
    arguments: Expr[];
  
    constructor(callee: Expr, paren: Token, args: Expr[]) {
      this.callee = callee;
      this.paren = paren;
      this.arguments = args;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitCallExpr(this);
    }
  }
import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class Unary implements Expr {
    operator: Token;
    right: Expr;
  
    constructor(operator: Token, right: Expr) {
      this.operator = operator;
      this.right = right;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitUnaryExpr(this);
    }
  }
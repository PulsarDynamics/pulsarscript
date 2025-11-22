import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class Binary implements Expr {
    left: Expr;
    operator: Token;
    right: Expr;
  
    constructor(left: Expr, operator: Token, right: Expr) {
      this.left = left;
      this.operator = operator;
      this.right = right;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitBinaryExpr(this);
    }
  }
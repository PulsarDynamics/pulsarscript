import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";

export class Grouping implements Expr {
    expression: Expr;
  
    constructor(expression: Expr) {
      this.expression = expression;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitGroupingExpr(this);
    }
  }
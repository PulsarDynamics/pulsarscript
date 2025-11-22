import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";

export class Literal implements Expr {
    value: any;
  
    constructor(value: any) {
      this.value = value;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitLiteralExpr(this);
    }
  }
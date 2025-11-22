import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class Assign implements Expr {
    name: Token;
    value: Expr;
  
    constructor(name: Token, value: Expr) {
      this.name = name;
      this.value = value;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      //console.log("visitor", visitor, this)
      return visitor.visitAssignExpr(this);
    }
  }
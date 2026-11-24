import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class Assign implements Expr {
    name: Token;
    value: Expr;
    compoundOp?: string;
    compoundRhs?: Expr;
  
    constructor(name: Token, value: Expr, compoundOp?: string, compoundRhs?: Expr) {
      this.name = name;
      this.value = value;
      if (compoundOp !== undefined) this.compoundOp = compoundOp;
      if (compoundRhs !== undefined) this.compoundRhs = compoundRhs;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      //console.log("visitor", visitor, this)
      return visitor.visitAssignExpr(this);
    }
  }
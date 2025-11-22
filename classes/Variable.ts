import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class Variable implements Expr {
    name: Token;
  
    constructor(name: Token) {
      this.name = name;
    }
  
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitVariableExpr(this);
    }
  }
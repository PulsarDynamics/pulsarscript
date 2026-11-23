import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";
import type { IndexExpr } from "./IndexExpr";

/**
 * Assignment to an element or property: `a[i] = v`, `o.key = v`, `a[i][j] += v`.
 * Arrays and objects are values (SPEC 3.3): the container is copied with the new
 * element and stored back into the variable at the root of `target`.
 */
export class SetIndex implements Expr {
    target: IndexExpr;
    value: Expr;
    equals: Token;
    operator: Token | null;
    line?: number;
    constructor(target: IndexExpr, value: Expr, equals: Token, operator: Token | null = null) {
      this.target = target;
      this.value = value;
      this.equals = equals;
      this.operator = operator;
      this.line = equals.line;
    }
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitSetIndexExpr(this);
    }
  }

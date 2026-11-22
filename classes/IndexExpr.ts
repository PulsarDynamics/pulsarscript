import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

/** `object[index]`, or `object.name` (then `index` is a string Literal and `member` is true). */
export class IndexExpr implements Expr {
    object: Expr;
    index: Expr;
    /** The `[` or `.` token, for line numbers and messages. */
    token: Token;
    member: boolean;
    line?: number;
    constructor(object: Expr, index: Expr, token: Token, member: boolean) {
      this.object = object;
      this.index = index;
      this.token = token;
      this.member = member;
      this.line = token.line;
    }
    accept<R>(visitor: ExprVisitor<R>): R {
      return visitor.visitIndexExpr(this);
    }
  }

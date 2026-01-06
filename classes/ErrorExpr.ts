import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";

export class ErrorExpr implements Expr {
  message: string;
  metadata: any;

  constructor(message: string, metadata: any = null) {
    this.message = message;
    this.metadata = metadata;
  }

  accept<R>(visitor: ExprVisitor<R>): R {
    return visitor.visitErrorExpr(this);
  }
}

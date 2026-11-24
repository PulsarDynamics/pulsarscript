import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";

export class Literal implements Expr {
  value: any;
  raw?: string;
  isTemplate?: boolean;

  constructor(value: any, raw?: string, isTemplate = false) {
    this.value = value;
    if (raw !== undefined) this.raw = raw;
    if (isTemplate) this.isTemplate = true;
  }

  accept<R>(visitor: ExprVisitor<R>): R {
    return visitor.visitLiteralExpr(this);
  }
}

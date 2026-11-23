import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export class TernaryExpr implements Expr {
  condition: Expr;
  question: Token;
  thenBranch: Expr;
  elseBranch: Expr;
  line?: number;

  constructor(condition: Expr, question: Token, thenBranch: Expr, elseBranch: Expr) {
    this.condition = condition;
    this.question = question;
    this.thenBranch = thenBranch;
    this.elseBranch = elseBranch;
    this.line = question.line;
  }

  accept<R>(visitor: ExprVisitor<R>): R {
    return visitor.visitTernaryExpr(this);
  }
}

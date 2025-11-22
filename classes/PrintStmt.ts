import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";

export class PrintStmt implements Stmt {
    expression: Expr;
  
    constructor(expression: Expr) {
      this.expression = expression;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitPrintStmt(this);
    }
  }
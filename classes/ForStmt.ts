import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";

export class ForStmt implements Stmt {
    initializer: Stmt | null;
    condition: Expr | null;
    increment: Expr | null;
    body: Stmt;
  
    constructor(initializer: Stmt | null, condition: Expr | null, increment: Expr | null, body: Stmt) {
      this.initializer = initializer;
      this.condition = condition;
      this.increment = increment;
      this.body = body;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitForStmt(this);
    }
  }

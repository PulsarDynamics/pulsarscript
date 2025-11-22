import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";

export class WhileStmt implements Stmt {
    condition: Expr;
    body: Stmt;
  
    constructor(condition: Expr, body: Stmt) {
      this.condition = condition;
      this.body = body;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitWhileStmt(this);
    }
  }
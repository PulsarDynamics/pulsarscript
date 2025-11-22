import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";

export class IfStmt implements Stmt {
    condition: Expr;
    thenBranch: Stmt;
    elseBranch: Stmt | null;
  
    constructor(condition: Expr, thenBranch: Stmt, elseBranch: Stmt | null) {
      this.condition = condition;
      this.thenBranch = thenBranch;
      this.elseBranch = elseBranch;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitIfStmt(this);
    }
  }
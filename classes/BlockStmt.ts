import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";

export class BlockStmt implements Stmt {
    statements: Stmt[];
  
    constructor(statements: Stmt[]) {
      this.statements = statements;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitBlockStmt(this);
    }
  }
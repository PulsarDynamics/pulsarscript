import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";

export class BlockStmt implements Stmt {
    statements: Stmt[];
    line?: number;
    endLine?: number;
    startOffset?: number;
    endOffset?: number;
  
    constructor(statements: Stmt[], endLine?: number, endOffset?: number) {
      this.statements = statements;
      if (endLine !== undefined) this.endLine = endLine;
      if (endOffset !== undefined) this.endOffset = endOffset;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitBlockStmt(this);
    }
  }
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

export class FunctionStmt implements Stmt {
    name: Token;
    params: Token[];
    body: Stmt[];
    endLine?: number;
    startOffset?: number;
    endOffset?: number;
  
    constructor(name: Token, params: Token[], body: Stmt[], endLine?: number, endOffset?: number) {
      this.name = name;
      this.params = params;
      this.body = body;
      if (endLine !== undefined) this.endLine = endLine;
      if (endOffset !== undefined) this.endOffset = endOffset;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitFunctionStmt(this);
    }
  }
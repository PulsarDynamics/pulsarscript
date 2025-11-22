import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

export class FunctionStmt implements Stmt {
    name: Token;
    params: Token[];
    body: Stmt[];
  
    constructor(name: Token, params: Token[], body: Stmt[]) {
      this.name = name;
      this.params = params;
      this.body = body;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitFunctionStmt(this);
    }
  }
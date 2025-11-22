import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

export class ReturnStmt implements Stmt {
    keyword: Token;
    value: Expr | null;
  
    constructor(keyword: Token, value: Expr | null) {
      this.keyword = keyword;
      this.value = value;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitReturnStmt(this);
    }
  }
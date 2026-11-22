import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

/** `break;` (`isContinue` false) or `continue;` (`isContinue` true). */
export class BreakStmt implements Stmt {
    keyword: Token;
    isContinue: boolean;
    line?: number;
    constructor(keyword: Token, isContinue: boolean) {
      this.keyword = keyword;
      this.isContinue = isContinue;
      this.line = keyword.line;
    }
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitBreakStmt(this);
    }
  }

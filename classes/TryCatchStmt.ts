import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

export class TryCatchStmt implements Stmt {
  tryBlock: Stmt[];
  catchParam: string | null;
  catchBlock: Stmt[];
  catchParamToken?: Token;
  tryEndLine?: number;
  tryEndOffset?: number;
  catchLine?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;

  constructor(tryBlock: Stmt[], catchParam: string | null, catchBlock: Stmt[], catchParamToken?: Token) {
    this.tryBlock = tryBlock;
    this.catchParam = catchParam;
    this.catchBlock = catchBlock;
    if (catchParamToken) this.catchParamToken = catchParamToken;
  }

  accept<R>(visitor: StmtVisitor<R>): R {
    return visitor.visitTryCatchStmt(this);
  }
}

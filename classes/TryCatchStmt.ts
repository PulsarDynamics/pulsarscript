import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Expr } from "../interfaces/Expr";

export class TryCatchStmt implements Stmt {
  tryBlock: Stmt[];
  catchParam: string | null;
  catchBlock: Stmt[];

  constructor(tryBlock: Stmt[], catchParam: string | null, catchBlock: Stmt[]) {
    this.tryBlock = tryBlock;
    this.catchParam = catchParam;
    this.catchBlock = catchBlock;
  }

  accept<R>(visitor: StmtVisitor<R>): R {
    return visitor.visitTryCatchStmt(this);
  }
}

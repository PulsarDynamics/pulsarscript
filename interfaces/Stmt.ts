import type { StmtVisitor } from "./StmtVisitor";

export interface Stmt {
  accept<R>(visitor: StmtVisitor<R>): R;
}
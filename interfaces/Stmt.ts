import type { StmtVisitor } from "./StmtVisitor";

export interface Stmt {
  /** Source line where the statement starts, set by the parser. */
  line?: number;
  accept<R>(visitor: StmtVisitor<R>): R;
}
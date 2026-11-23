import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

export interface ExportSpecifier {
  local: Token;
  exported: Token;
}

export class ExportStmt implements Stmt {
  line?: number;
  sourceIndex?: number;
  keyword: Token;
  declaration: Stmt | null;
  specifiers: ExportSpecifier[] | null;

  constructor(keyword: Token, declaration: Stmt | null, specifiers: ExportSpecifier[] | null) {
    this.keyword = keyword;
    this.declaration = declaration;
    this.specifiers = specifiers;
    this.line = keyword.line;
  }

  accept<R>(visitor: StmtVisitor<R>): R {
    return visitor.visitExportStmt(this);
  }
}

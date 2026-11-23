import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

export interface ImportSpecifier {
  imported: Token;
  local: Token;
}

export class ImportStmt implements Stmt {
  line?: number;
  sourceIndex?: number;
  keyword: Token;
  specifiers: ImportSpecifier[];
  source: Token;

  constructor(keyword: Token, specifiers: ImportSpecifier[], source: Token) {
    this.keyword = keyword;
    this.specifiers = specifiers;
    this.source = source;
    this.line = keyword.line;
  }

  accept<R>(visitor: StmtVisitor<R>): R {
    return visitor.visitImportStmt(this);
  }
}

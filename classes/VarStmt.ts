import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

export class VarStmt implements Stmt {
    name: Token;
    initializer: Expr | null;
    /** Declared with `const`: must be initialised and cannot be reassigned. */
    isConst: boolean;
  
    constructor(name: Token, initializer: Expr | null, isConst = false) {
      this.name = name;
      this.initializer = initializer;
      this.isConst = isConst;
    }
  
    accept<R>(visitor: StmtVisitor<R>): R {
      ////console.log("visitor", visitor)
      ////console.log("this", this)
      return visitor.visitVarStmt(this);
    }
  }
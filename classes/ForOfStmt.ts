import type { Expr } from "../interfaces/Expr";
import type { Stmt } from "../interfaces/Stmt";
import type { StmtVisitor } from "../interfaces/StmtVisitor";
import type { Token } from "../interfaces/Token";

/**
 * `for (var x of items) body` / `for (const x of items) body`.
 * Arrays yield their elements, objects their keys (sorted, as objKeys does),
 * strings their characters. The iterable is evaluated once.
 */
export class ForOfStmt implements Stmt {
    name: Token;
    isConst: boolean;
    iterable: Expr;
    body: Stmt;
    line?: number;
    constructor(name: Token, isConst: boolean, iterable: Expr, body: Stmt) {
      this.name = name;
      this.isConst = isConst;
      this.iterable = iterable;
      this.body = body;
    }
    accept<R>(visitor: StmtVisitor<R>): R {
      return visitor.visitForOfStmt(this);
    }
  }

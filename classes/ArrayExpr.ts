import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";

export class ArrayExpr implements Expr {
    elements: Expr[];

    constructor(elements: Expr[]) {
        this.elements = elements;
    }

    accept<R>(visitor: ExprVisitor<R>): R {
        return visitor.visitArrayExpr(this);
    }
}

import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";

export class ArrayExpr implements Expr {
    elements: Expr[];
    endLine?: number;

    constructor(elements: Expr[], endLine?: number) {
        this.elements = elements;
        if (endLine !== undefined) this.endLine = endLine;
    }

    accept<R>(visitor: ExprVisitor<R>): R {
        return visitor.visitArrayExpr(this);
    }
}

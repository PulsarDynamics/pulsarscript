import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";

export interface ObjectProperty {
    key: string;
    value: Expr;
}

export class ObjectExpr implements Expr {
    properties: ObjectProperty[];

    constructor(properties: ObjectProperty[]) {
        this.properties = properties;
    }

    accept<R>(visitor: ExprVisitor<R>): R {
        return visitor.visitObjectExpr(this);
    }
}

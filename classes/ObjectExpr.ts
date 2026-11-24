import type { Expr } from "../interfaces/Expr";
import type { ExprVisitor } from "../interfaces/ExprVisitor";
import type { Token } from "../interfaces/Token";

export interface ObjectProperty {
    key: string;
    value: Expr;
    keyToken?: Token;
    quoted?: boolean;
}

export class ObjectExpr implements Expr {
    properties: ObjectProperty[];
    endLine?: number;

    constructor(properties: ObjectProperty[], endLine?: number) {
        this.properties = properties;
        if (endLine !== undefined) this.endLine = endLine;
    }

    accept<R>(visitor: ExprVisitor<R>): R {
        return visitor.visitObjectExpr(this);
    }
}

import type { ExprVisitor } from "./ExprVisitor";

export interface Expr {
    /** Source line, set by the parser on literals, groupings, arrays and objects. */
    line?: number;
    accept<R>(visitor: ExprVisitor<R>): R;
}
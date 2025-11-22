import type { ExprVisitor } from "./ExprVisitor";

export interface Expr {
    accept<R>(visitor: ExprVisitor<R>): R;
}
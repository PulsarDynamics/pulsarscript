import type { IndexExpr } from "../classes/IndexExpr";
import type { SetIndex } from "../classes/SetIndex";
import type { Assign } from "../classes/Assign";
import type { Binary } from "../classes/Binary";
import type { Call } from "../classes/Call";
import type { Grouping } from "../classes/Grouping";
import type { ErrorExpr } from "../classes/ErrorExpr";
import type { Literal } from "../classes/Literal";
import type { Unary } from "../classes/Unary";
import type { Variable } from "../classes/Variable";
import type { ArrayExpr } from "../classes/ArrayExpr";
import type { ObjectExpr } from "../classes/ObjectExpr";
import type { TernaryExpr } from "../classes/TernaryExpr";
import type { TemplateLiteralExpr } from "../classes/TemplateLiteralExpr";
import type { FunctionExpr } from "../classes/FunctionExpr";

export interface ExprVisitor<R> {
  visitBinaryExpr(expr: Binary): R;
  visitGroupingExpr(expr: Grouping): R;
  visitLiteralExpr(expr: Literal): R;
  visitUnaryExpr(expr: Unary): R;
  visitVariableExpr(expr: Variable): R;
  visitAssignExpr(expr: Assign): R;
  visitCallExpr(expr: Call): R;
  visitErrorExpr(expr: ErrorExpr): R;
  visitArrayExpr(expr: ArrayExpr): R;
  visitObjectExpr(expr: ObjectExpr): R;
  visitIndexExpr(expr: IndexExpr): R;
  visitSetIndexExpr(expr: SetIndex): R;
  visitTernaryExpr(expr: TernaryExpr): R;
  visitTemplateLiteralExpr(expr: TemplateLiteralExpr): R;
  visitFunctionExpr(expr: FunctionExpr): R;
}

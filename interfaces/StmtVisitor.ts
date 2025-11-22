import type { BlockStmt } from "../classes/BlockStmt";
import type { ExpressionStmt } from "../classes/ExpressionStmt";
import type { ForStmt } from "../classes/ForStmt";
import type { FunctionStmt } from "../classes/FunctionStmt";
import type { IfStmt } from "../classes/IfStmt";
import type { PrintStmt } from "../classes/PrintStmt";
import type { ReturnStmt } from "../classes/ReturnStmt";
import type { VarStmt } from "../classes/VarStmt";
import type { WhileStmt } from "../classes/WhileStmt";

export interface StmtVisitor<R> {
    visitExpressionStmt(stmt: ExpressionStmt): R;
    visitPrintStmt(stmt: PrintStmt): R;
    visitVarStmt(stmt: VarStmt): R;
    visitBlockStmt(stmt: BlockStmt): R;
    visitIfStmt(stmt: IfStmt): R;
    visitWhileStmt(stmt: WhileStmt): R;
    visitForStmt(stmt: ForStmt): R;
    visitFunctionStmt(stmt: FunctionStmt): R;
    visitReturnStmt(stmt: ReturnStmt): R;
  }
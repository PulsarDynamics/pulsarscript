import type { TokenType } from "../enums/TokenType";

export interface Token {
    type: TokenType;
    lexeme: string;
    literal: any;
    line: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    startOffset?: number;
    endOffset?: number;
}
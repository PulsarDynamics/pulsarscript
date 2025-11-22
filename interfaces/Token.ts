import type { TokenType } from "../enums/TokenType";

export interface Token {
    type: TokenType;
    lexeme: string;
    literal: any;
    line: number;
}
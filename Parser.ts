import { Assign } from "./classes/Assign";
import { Binary } from "./classes/Binary";
import { BlockStmt } from "./classes/BlockStmt";
import { Call } from "./classes/Call";
import { ExpressionStmt } from "./classes/ExpressionStmt";
import { ForStmt } from "./classes/ForStmt";
import { FunctionStmt } from "./classes/FunctionStmt";
import { Grouping } from "./classes/Grouping";
import { IfStmt } from "./classes/IfStmt";
import { Literal } from "./classes/Literal";
import { PrintStmt } from "./classes/PrintStmt";
import { ReturnStmt } from "./classes/ReturnStmt";
import { Unary } from "./classes/Unary";
import { VarStmt } from "./classes/VarStmt";
import { Variable } from "./classes/Variable";
import { WhileStmt } from "./classes/WhileStmt";
import { TokenType } from "./enums/TokenType";
import type { Expr } from "./interfaces/Expr";
import type { Stmt } from "./interfaces/Stmt";
import type { Token } from "./interfaces/Token";

export class Parser {
    private tokens: Token[];
    private current = 0;

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    parse(): Stmt[] {
        const statements: Stmt[] = [];
        while (!this.isAtEnd()) {
            let a = this.declaration()
            //console.log("parsing:", a)
            statements.push(a);
        }
        return statements;
    }

    private declaration(): Stmt {
        try {
            if (this.match(TokenType.VAR)) return this.varDeclaration();
            if (this.match(TokenType.FUNCTION)) return this.function("function");
            return this.statement();
        } catch (error) {
            this.synchronize();
            return new ExpressionStmt(new Literal(null));
        }
    }

    private varDeclaration(): Stmt {
        const name = this.consume(TokenType.IDENTIFIER, "Expect variable name.");
        //console.log("name", name)
        let initializer: Expr | null = null;
        if (this.match(TokenType.EQUAL)) {
            initializer = this.expression();
            //console.log("initializer", initializer)
        }

        this.consume(TokenType.SEMICOLON, "Expect ';' after variable declaration.");
        return new VarStmt(name, initializer);
    }

    private function(kind: string): FunctionStmt {
        const name = this.consume(TokenType.IDENTIFIER, `Expect ${kind} name.`);
        this.consume(TokenType.LEFT_PAREN, `Expect '(' after ${kind} name.`);
        const parameters: Token[] = [];
        if (!this.check(TokenType.RIGHT_PAREN)) {
            do {
                if (parameters.length >= 255) {
                    this.error(this.peek(), "Can't have more than 255 parameters.");
                }
                parameters.push(this.consume(TokenType.IDENTIFIER, "Expect parameter name."));
            } while (this.match(TokenType.COMMA));
        }
        this.consume(TokenType.RIGHT_PAREN, "Expect ')' after parameters.");

        this.consume(TokenType.LEFT_BRACE, `Expect '{' before ${kind} body.`);
        const body = this.block();
        return new FunctionStmt(name, parameters, body);
    }

    private statement(): Stmt {
        if (this.match(TokenType.PRINT)) return this.printStatement();
        if (this.match(TokenType.IF)) return this.ifStatement();
        if (this.match(TokenType.WHILE)) return this.whileStatement();
        if (this.match(TokenType.FOR)) return this.forStatement();
        if (this.match(TokenType.LEFT_BRACE)) return new BlockStmt(this.block());
        if (this.match(TokenType.RETURN)) return this.returnStatement();

        return this.expressionStatement();
    }

    private printStatement(): Stmt {
        const value = this.expression();
        this.consume(TokenType.SEMICOLON, "Expect ';' after value.");
        return new PrintStmt(value);
    }

    private ifStatement(): Stmt {
        this.consume(TokenType.LEFT_PAREN, "Expect '(' after 'if'.");
        const condition = this.expression();
        this.consume(TokenType.RIGHT_PAREN, "Expect ')' after if condition.");

        const thenBranch = this.statement();
        let elseBranch = null;
        if (this.match(TokenType.ELSE)) {
            elseBranch = this.statement();
        }

        return new IfStmt(condition, thenBranch, elseBranch);
    }

    private whileStatement(): Stmt {
        this.consume(TokenType.LEFT_PAREN, "Expect '(' after 'while'.");
        const condition = this.expression();
        this.consume(TokenType.RIGHT_PAREN, "Expect ')' after condition.");
        const body = this.statement();

        return new WhileStmt(condition, body);
    }

    private forStatement(): Stmt {
        this.consume(TokenType.LEFT_PAREN, "Expect '(' after 'for'.");

        let initializer: Stmt | null = null;
        if (this.match(TokenType.SEMICOLON)) {
            initializer = null;
        } else if (this.match(TokenType.VAR)) {
                // Handle variable declaration in for loop initializer
                const name = this.consume(TokenType.IDENTIFIER, "Expect variable name.");
                let init: Expr | null = null;
                if (this.match(TokenType.EQUAL)) {
                    init = this.expression();
                }
                this.consume(TokenType.SEMICOLON, "Expect ';' after variable declaration.");
                initializer = new VarStmt(name, init);
        } else {
            initializer = this.expressionStatement();
        }

        let condition: Expr | null = null;
        if (!this.check(TokenType.SEMICOLON)) {
            condition = this.expression();
        }
        this.consume(TokenType.SEMICOLON, "Expect ';' after loop condition.");

        let increment: Expr | null = null;
        if (!this.check(TokenType.RIGHT_PAREN)) {
            increment = this.expression();
        }
        this.consume(TokenType.RIGHT_PAREN, "Expect ')' after for clauses.");

        let body = this.statement();

        return new ForStmt(initializer, condition, increment, body);
    }

    private returnStatement(): Stmt {
        const keyword = this.previous();
        let value = null;
        if (!this.check(TokenType.SEMICOLON)) {
            value = this.expression();
        }

        this.consume(TokenType.SEMICOLON, "Expect ';' after return value.");
        return new ReturnStmt(keyword, value);
    }

    private expressionStatement(): Stmt {
        const expr = this.expression();
        this.consume(TokenType.SEMICOLON, "Expect ';' after expression.");
        return new ExpressionStmt(expr);
    }

    private block(): Stmt[] {
        const statements: Stmt[] = [];

        while (!this.check(TokenType.RIGHT_BRACE) && !this.isAtEnd()) {
            statements.push(this.declaration());
        }

        this.consume(TokenType.RIGHT_BRACE, "Expect '}' after block.");
        return statements;
    }

    private expression(): Expr {
        return this.assignment();
    }
    
    private assignment(): Expr {
        const expr = this.or();
    
        if (this.match(TokenType.EQUAL)) {
            const equals = this.previous();
            const value = this.assignment();
    
            if (expr instanceof Variable) {
                const name = expr.name;
                return new Assign(name, value);
            }

            this.error(equals, "Invalid assignment target.");
        }
    
        return expr;
    }

    private or(): Expr {
        let expr = this.and();

        while (this.match(TokenType.OR)) {
            const operator = this.previous();
            const right = this.and();
            expr = new Binary(expr, operator, right);
        }

        return expr;
    }

    private and(): Expr {
        let expr = this.equality();

        while (this.match(TokenType.AND)) {
            const operator = this.previous();
            const right = this.equality();
            expr = new Binary(expr, operator, right);
        }

        return expr;
    }

    private equality(): Expr {
        let expr = this.comparison();

        while (this.match(TokenType.BANG_EQUAL, TokenType.EQUAL_EQUAL)) {
            const operator = this.previous();
            const right = this.comparison();
            expr = new Binary(expr, operator, right);
        }

        return expr;
    }

    private comparison(): Expr {
        let expr = this.term();

        while (this.match(TokenType.GREATER, TokenType.GREATER_EQUAL, TokenType.LESS, TokenType.LESS_EQUAL)) {
            const operator = this.previous();
            const right = this.term();
            expr = new Binary(expr, operator, right);
        }

        return expr;
    }

    private term(): Expr {
        let expr = this.factor();

        while (this.match(TokenType.MINUS, TokenType.PLUS)) {
            const operator = this.previous();
            const right = this.factor();
            expr = new Binary(expr, operator, right);
        }

        return expr;
    }

    private factor(): Expr {
        let expr = this.unary();

        while (this.match(TokenType.SLASH, TokenType.STAR)) {
            const operator = this.previous();
            const right = this.unary();
            expr = new Binary(expr, operator, right);
        }

        return expr;
    }

    private unary(): Expr {
        if (this.match(TokenType.BANG, TokenType.MINUS)) {
            const operator = this.previous();
            const right = this.unary();
            return new Unary(operator, right);
        }

        return this.call();
    }

    private call(): Expr {
        let expr = this.primary();

        while (true) {
            if (this.match(TokenType.LEFT_PAREN)) {
                expr = this.finishCall(expr);
            } else {
                break;
            }
        }

        return expr;
    }

    private finishCall(callee: Expr): Expr {
        const args: Expr[] = [];
        if (!this.check(TokenType.RIGHT_PAREN)) {
            do {
                if (args.length >= 255) {
                    this.error(this.peek(), "Can't have more than 255 arguments.");
                }
                args.push(this.expression());
            } while (this.match(TokenType.COMMA));
        }

        const paren = this.consume(TokenType.RIGHT_PAREN, "Expect ')' after arguments.");

        return new Call(callee, paren, args);
    }

    private primary(): Expr {
        if (this.match(TokenType.FALSE)) return new Literal(false);
        if (this.match(TokenType.TRUE)) return new Literal(true);
        if (this.match(TokenType.NIL)) return new Literal(null);

        if (this.match(TokenType.NUMBER, TokenType.STRING)) {
            return new Literal(this.previous().literal);
        }

        if (this.match(TokenType.IDENTIFIER)) {
            return new Variable(this.previous());
        }

        if (this.match(TokenType.LEFT_PAREN)) {
            const expr = this.expression();
            this.consume(TokenType.RIGHT_PAREN, "Expect ')' after expression.");
            return new Grouping(expr);
        }

        throw this.error(this.peek(), "Expect expression.");
    }

    private match(...types: TokenType[]): boolean {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }

    private check(type: TokenType): boolean {
        if (this.isAtEnd()) return false;
        return this.peek().type === type;
    }

    private advance(): Token {
        if (!this.isAtEnd()) this.current++;
        return this.previous();
    }

    private isAtEnd(): boolean {
        return this.peek().type === TokenType.EOF;
    }

    private peek(): Token {
        return this.tokens[this.current];
    }

    private previous(): Token {
        return this.tokens[this.current - 1];
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) return this.advance();
        throw this.error(this.peek(), message);
    }

    private error(token: Token, message: string): ParseError {
        return new ParseError(token, message);
    }

    private synchronize(): void {
        this.advance();

        while (!this.isAtEnd()) {
            if (this.previous().type === TokenType.SEMICOLON) return;

            switch (this.peek().type) {
                case TokenType.FUNCTION:
                case TokenType.VAR:
                case TokenType.FOR:
                case TokenType.IF:
                case TokenType.WHILE:
                case TokenType.PRINT:
                case TokenType.RETURN:
                    return;
            }

            this.advance();
        }
    }
}

export class ParseError extends Error {
    token: Token;

    constructor(token: Token, message: string) {
        super(message);
        this.token = token;
    }
}

/*
    
    // Example usage:
    const lexer = new Lexer(sourceCode); // Assuming you have a Lexer class
    const tokens = lexer.scanTokens();
    const parser = new Parser(tokens);
    const statements = parser.parse();
    
    console.log(statements); // This will output the AST
*/
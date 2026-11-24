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
import { TryCatchStmt } from "./classes/TryCatchStmt";
import { ArrayExpr } from "./classes/ArrayExpr";
import { ObjectExpr, type ObjectProperty } from "./classes/ObjectExpr";
import { TokenType } from "./enums/TokenType";
import { IndexExpr } from "./classes/IndexExpr";
import { SetIndex } from "./classes/SetIndex";
import { BreakStmt } from "./classes/BreakStmt";
import { ForOfStmt } from "./classes/ForOfStmt";
import { TernaryExpr } from "./classes/TernaryExpr";
import { TemplateLiteralExpr } from "./classes/TemplateLiteralExpr";
import { FunctionExpr } from "./classes/FunctionExpr";
import { ImportStmt, type ImportSpecifier } from "./classes/ImportStmt";
import { ExportStmt, type ExportSpecifier } from "./classes/ExportStmt";
import type { Expr } from "./interfaces/Expr";
import type { Stmt } from "./interfaces/Stmt";
import type { Token } from "./interfaces/Token";

export class Parser {
    private tokens: Token[];
    private current = 0;

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    /** Syntax errors found so far. Parsing recovers after each one so all of them are reported. */
    readonly errors: ParseError[] = [];

    /**
     * Parse the whole token stream. If any syntax error was found, throws the first
     * ParseError, with every error found attached as `errors` (SPEC 5, defect D13).
     */
    parse(): Stmt[] {
        const statements: Stmt[] = [];
        while (!this.isAtEnd()) {
            statements.push(this.declaration());
        }
        if (this.errors.length > 0) {
            const first = this.errors[0];
            first.errors = [...this.errors];
            throw first;
        }
        return statements;
    }

    // Statements and primary expressions record their source line for the compiler's line
    // map, so runtime errors point at the right line on the VM (D18).
    private withLine<T>(line: number, node: T, startOffset?: number): T {
        const n = node as { line?: number; startOffset?: number; endOffset?: number; endLine?: number };
        if (n.line === undefined) n.line = line;
        if (startOffset !== undefined && n.startOffset === undefined) n.startOffset = startOffset;
        const endTok = this.tokens[Math.max(0, this.current - 1)];
        if (endTok && n.endOffset === undefined && endTok.endOffset !== undefined) n.endOffset = endTok.endOffset;
        if (endTok && n.endLine === undefined) n.endLine = endTok.endLine ?? endTok.line;
        return node;
    }

    private declaration(): Stmt {
        const start = this.peek();
        const line = start.line;
        const startOff = start.startOffset;
        try {
            if (this.match(TokenType.IMPORT)) return this.withLine(line, this.importDeclaration(this.previous()), startOff);
            if (this.match(TokenType.EXPORT)) return this.withLine(line, this.exportDeclaration(this.previous()), startOff);
            if (this.match(TokenType.VAR)) return this.withLine(line, this.varDeclaration(), startOff);
            if (this.match(TokenType.CONST)) return this.withLine(line, this.varDeclaration(true), startOff);
            if (this.check(TokenType.FUNCTION) && this.peekAt(1).type === TokenType.IDENTIFIER) {
                this.advance();
                return this.withLine(line, this.function("function"), startOff);
            }
            return this.statement();
        } catch (error) {
            this.synchronize();
            return new ExpressionStmt(new Literal(null));
        }
    }

    private matchContextualKeyword(word: string): boolean {
        if (this.check(TokenType.IDENTIFIER) && this.peek().lexeme === word) {
            this.advance();
            return true;
        }
        return false;
    }

    private consumeContextualKeyword(word: string, message: string): Token {
        if (this.check(TokenType.IDENTIFIER) && this.peek().lexeme === word) {
            return this.advance();
        }
        throw this.error(this.peek(), message);
    }

    private importDeclaration(keyword: Token): Stmt {
        this.consume(TokenType.LEFT_BRACE, "Expect '{' after 'import'.");
        const specifiers: ImportSpecifier[] = [];
        if (!this.check(TokenType.RIGHT_BRACE)) {
            do {
                if (this.check(TokenType.RIGHT_BRACE)) break;
                const imported = this.consume(TokenType.IDENTIFIER, "Expect imported identifier.");
                let local = imported;
                if (this.matchContextualKeyword("as")) {
                    local = this.consume(TokenType.IDENTIFIER, "Expect alias identifier after 'as'.");
                }
                specifiers.push({ imported, local });
            } while (this.match(TokenType.COMMA));
        }
        this.consume(TokenType.RIGHT_BRACE, "Expect '}' after import specifiers.");
        this.consumeContextualKeyword("from", "Expect 'from' after import specifiers.");
        const source = this.consume(TokenType.STRING, "Expect module path string after 'from'.");
        this.consume(TokenType.SEMICOLON, "Expect ';' after import declaration.");
        return new ImportStmt(keyword, specifiers, source);
    }

    private exportDeclaration(keyword: Token): Stmt {
        if (this.match(TokenType.VAR)) {
            return new ExportStmt(keyword, this.withLine(this.previous().line, this.varDeclaration(false)), null);
        }
        if (this.match(TokenType.CONST)) {
            return new ExportStmt(keyword, this.withLine(this.previous().line, this.varDeclaration(true)), null);
        }
        if (this.check(TokenType.FUNCTION) && this.peekAt(1).type === TokenType.IDENTIFIER) {
            this.advance();
            return new ExportStmt(keyword, this.withLine(this.previous().line, this.function("function")), null);
        }
        if (this.match(TokenType.LEFT_BRACE)) {
            const specifiers: ExportSpecifier[] = [];
            if (!this.check(TokenType.RIGHT_BRACE)) {
                do {
                    if (this.check(TokenType.RIGHT_BRACE)) break;
                    const local = this.consume(TokenType.IDENTIFIER, "Expect exported identifier.");
                    let exported = local;
                    if (this.matchContextualKeyword("as")) {
                        exported = this.consume(TokenType.IDENTIFIER, "Expect export alias identifier after 'as'.");
                    }
                    specifiers.push({ local, exported });
                } while (this.match(TokenType.COMMA));
            }
            this.consume(TokenType.RIGHT_BRACE, "Expect '}' after export specifiers.");
            this.consume(TokenType.SEMICOLON, "Expect ';' after export statement.");
            return new ExportStmt(keyword, null, specifiers);
        }
        throw this.error(this.peek(), "Expect 'function', 'var', 'const', or '{' after 'export'.");
    }

    private varDeclaration(isConst = false): Stmt {
        const name = this.consume(TokenType.IDENTIFIER, "Expect variable name.");
        //console.log("name", name)
        let initializer: Expr | null = null;
        if (this.match(TokenType.EQUAL)) {
            initializer = this.expression();
            //console.log("initializer", initializer)
        }

        if (isConst && initializer === null) {
            this.error(name, `Constant '${name.lexeme}' must be initialised.`);
        }
        this.consume(TokenType.SEMICOLON, "Expect ';' after variable declaration.");
        return new VarStmt(name, initializer, isConst);
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
        return new FunctionStmt(name, parameters, body, this.previous().line, this.previous().endOffset);
    }

    private statement(): Stmt {
        const start = this.peek();
        return this.withLine(start.line, this.statementWithoutLine(), start.startOffset);
    }

    private statementWithoutLine(): Stmt {
        if (this.match(TokenType.PRINT)) return this.printStatement();
        if (this.match(TokenType.IF)) return this.ifStatement();
        if (this.match(TokenType.WHILE)) return this.whileStatement();
        if (this.match(TokenType.FOR)) return this.forStatement();
        if (this.match(TokenType.LEFT_BRACE)) {
            const stmts = this.block();
            return new BlockStmt(stmts, this.previous().line, this.previous().endOffset);
        }
        if (this.match(TokenType.RETURN)) return this.returnStatement();
        if (this.match(TokenType.TRY)) return this.tryCatchStatement();
        if (this.match(TokenType.BREAK, TokenType.CONTINUE)) {
            const keyword = this.previous();
            this.consume(TokenType.SEMICOLON, `Expect ';' after '${keyword.lexeme}'.`);
            return new BreakStmt(keyword, keyword.type === TokenType.CONTINUE);
        }

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

        // for (var x of items) / for (const x of items)
        if ((this.check(TokenType.VAR) || this.check(TokenType.CONST)) && this.peekAt(1).type === TokenType.IDENTIFIER
            && this.peekAt(2).type === TokenType.IDENTIFIER && this.peekAt(2).lexeme === "of") {
            const isConst = this.advance().type === TokenType.CONST;
            const name = this.advance();
            this.advance(); // of
            const iterable = this.expression();
            this.consume(TokenType.RIGHT_PAREN, "Expect ')' after for-of clause.");
            const body = this.statement();
            const stmt = new ForOfStmt(name, isConst, iterable, body);
            stmt.line = name.line;
            return stmt;
        }

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

    private tryCatchStatement(): Stmt {
        this.consume(TokenType.LEFT_BRACE, "Expect '{' after 'try'.");
        const tryBlock = this.block();
        const tryEndLine = this.previous().line;
        const tryEndOffset = this.previous().endOffset;
        let catchParam: string | null = null;
        let catchParamToken: Token | undefined;
        let catchBlock: Stmt[] = [];
        let catchLine: number | undefined;
        let endLine: number | undefined;
        let endOffset: number | undefined;
        if (this.match(TokenType.CATCH)) {
            catchLine = this.previous().line;
            if (this.match(TokenType.LEFT_PAREN)) {
                const ident = this.consume(TokenType.IDENTIFIER, "Expect identifier after 'catch('.");
                catchParam = ident.lexeme;
                catchParamToken = ident;
                this.consume(TokenType.RIGHT_PAREN, "Expect ')' after catch parameter.");
            }
            this.consume(TokenType.LEFT_BRACE, "Expect '{' to start catch block.");
            catchBlock = this.block();
            endLine = this.previous().line;
            endOffset = this.previous().endOffset;
        } else {
            this.error(this.peek(), "Expect 'catch' after try block.");
        }
        const node = new TryCatchStmt(tryBlock, catchParam, catchBlock, catchParamToken);
        node.tryEndLine = tryEndLine;
        node.tryEndOffset = tryEndOffset;
        node.catchLine = catchLine;
        node.endLine = endLine;
        node.endOffset = endOffset;
        return node;
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
        const expr = this.ternary();

        if (this.match(TokenType.EQUAL, TokenType.PLUS_EQUAL, TokenType.MINUS_EQUAL)
            || this.match(TokenType.STAR_EQUAL, TokenType.SLASH_EQUAL, TokenType.PERCENT_EQUAL)) {
            const equals = this.previous();
            const rawValue = this.assignment();

            if (expr instanceof Variable) {
                let value = rawValue;
                let compoundOp: string | undefined;
                if (equals.type !== TokenType.EQUAL) {
                    const opType = {
                        [TokenType.PLUS_EQUAL]: TokenType.PLUS,
                        [TokenType.MINUS_EQUAL]: TokenType.MINUS,
                        [TokenType.STAR_EQUAL]: TokenType.STAR,
                        [TokenType.SLASH_EQUAL]: TokenType.SLASH,
                        [TokenType.PERCENT_EQUAL]: TokenType.PERCENT,
                    }[equals.type as string] as TokenType;
                    const operator: Token = { ...equals, type: opType, lexeme: equals.lexeme.slice(0, -1) };
                    value = new Binary(expr, operator, rawValue);
                    compoundOp = equals.lexeme;
                }
                return new Assign(expr.name, value, compoundOp, compoundOp ? rawValue : undefined);
            }
            if (expr instanceof IndexExpr) {
                let operator: Token | null = null;
                if (equals.type !== TokenType.EQUAL) {
                    const opType = {
                        [TokenType.PLUS_EQUAL]: TokenType.PLUS,
                        [TokenType.MINUS_EQUAL]: TokenType.MINUS,
                        [TokenType.STAR_EQUAL]: TokenType.STAR,
                        [TokenType.SLASH_EQUAL]: TokenType.SLASH,
                        [TokenType.PERCENT_EQUAL]: TokenType.PERCENT,
                    }[equals.type as string] as TokenType;
                    operator = { ...equals, type: opType, lexeme: equals.lexeme.slice(0, -1) };
                }
                return new SetIndex(expr, rawValue, equals, operator);
            }

            this.error(equals, "Invalid assignment target.");
        }

        return expr;
    }

    private ternary(): Expr {
        const expr = this.or();
        if (this.match(TokenType.QUESTION)) {
            const question = this.previous();
            const thenBranch = this.expression();
            this.consume(TokenType.COLON, "Expect ':' after ternary branch.");
            const elseBranch = this.ternary();
            return new TernaryExpr(expr, question, thenBranch, elseBranch);
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

        while (this.match(TokenType.SLASH, TokenType.STAR, TokenType.PERCENT)) {
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
            } else if (this.match(TokenType.LEFT_BRACKET)) {
                const bracket = this.previous();
                const index = this.expression();
                this.consume(TokenType.RIGHT_BRACKET, "Expect ']' after index.");
                expr = new IndexExpr(expr, index, bracket, false);
            } else if (this.match(TokenType.DOT)) {
                const dot = this.previous();
                const name = this.consume(TokenType.IDENTIFIER, "Expect property name after '.'.");
                const key = this.withLine(name.line, new Literal(name.lexeme));
                expr = new IndexExpr(expr, key, dot, true);
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
        const line = this.peek().line;
        return this.withLine(line, this.primaryWithoutLine());
    }

    private primaryWithoutLine(): Expr {
        if (this.match(TokenType.FALSE)) return new Literal(false);
        if (this.match(TokenType.TRUE)) return new Literal(true);
        if (this.match(TokenType.NIL)) return new Literal(null);

        if (this.match(TokenType.NUMBER, TokenType.STRING, TokenType.TEMPLATE_STRING)) {
            const prev = this.previous();
            return new Literal(prev.literal, prev.lexeme, prev.type === TokenType.TEMPLATE_STRING);
        }

        if (this.match(TokenType.TEMPLATE_HEAD)) {
            const head = this.previous();
            const parts: Expr[] = [this.withLine(head.line, new Literal(head.literal, head.lexeme, true))];
            while (true) {
                parts.push(this.expression());
                if (this.match(TokenType.TEMPLATE_MIDDLE)) {
                    const mid = this.previous();
                    parts.push(this.withLine(mid.line, new Literal(mid.literal, mid.lexeme, true)));
                    continue;
                }
                const tail = this.consume(TokenType.TEMPLATE_TAIL, "Expect '}' after template expression.");
                parts.push(this.withLine(tail.line, new Literal(tail.literal, tail.lexeme, true)));
                break;
            }
            return new TemplateLiteralExpr(parts, head);
        }

        if (this.match(TokenType.FUNCTION)) {
            const keyword = this.previous();
            const name = this.check(TokenType.IDENTIFIER) ? this.advance() : null;
            this.consume(TokenType.LEFT_PAREN, "Expect '(' after function.");
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
            this.consume(TokenType.LEFT_BRACE, "Expect '{' before function body.");
            const body = this.block();
            return new FunctionExpr(keyword, name, parameters, body, this.previous().line, this.previous().endOffset);
        }

        if (this.match(TokenType.IDENTIFIER)) {
            return new Variable(this.previous());
        }

        if (this.match(TokenType.LEFT_PAREN)) {
            const expr = this.expression();
            this.consume(TokenType.RIGHT_PAREN, "Expect ')' after expression.");
            return new Grouping(expr);
        }

        // Array literal: [element, element, ...]
        if (this.match(TokenType.LEFT_BRACKET)) {
            const elements: Expr[] = [];
            if (!this.check(TokenType.RIGHT_BRACKET)) {
                do {
                    elements.push(this.expression());
                } while (this.match(TokenType.COMMA));
            }
            this.consume(TokenType.RIGHT_BRACKET, "Expect ']' after array elements.");
            return new ArrayExpr(elements, this.previous().line);
        }

        // Object literal: {key: value, key2: value2, ...}
        if (this.match(TokenType.LEFT_BRACE)) {
            const properties: ObjectProperty[] = [];
            if (!this.check(TokenType.RIGHT_BRACE)) {
                do {
                    // Key must be an identifier or string
                    let key: string;
                    let keyToken: Token;
                    let quoted = false;
                    if (this.match(TokenType.IDENTIFIER)) {
                        keyToken = this.previous();
                        key = keyToken.lexeme;
                    } else if (this.match(TokenType.STRING)) {
                        keyToken = this.previous();
                        key = keyToken.literal as string;
                        quoted = true;
                    } else {
                        throw this.error(this.peek(), "Expect property name.");
                    }
                    this.consume(TokenType.COLON, "Expect ':' after property name.");
                    const value = this.expression();
                    properties.push({ key, value, keyToken, quoted });
                } while (this.match(TokenType.COMMA));
            }
            this.consume(TokenType.RIGHT_BRACE, "Expect '}' after object properties.");
            return new ObjectExpr(properties, this.previous().line);
        }

        throw this.error(this.peek(), "Expect expression.");
    }

    private match(type1: TokenType): boolean;
    private match(type1: TokenType, type2: TokenType): boolean;
    private match(type1: TokenType, type2: TokenType, type3: TokenType): boolean;
    private match(
        type1: TokenType,
        type2: TokenType,
        type3: TokenType,
        type4: TokenType
    ): boolean;
    private match(
        t1: TokenType,
        t2?: TokenType,
        t3?: TokenType,
        t4?: TokenType
    ): boolean {
        if (this.check(t1)) {
            this.advance();
            return true;
        }
        if (t2 !== undefined && this.check(t2)) {
            this.advance();
            return true;
        }
        if (t3 !== undefined && this.check(t3)) {
            this.advance();
            return true;
        }
        if (t4 !== undefined && this.check(t4)) {
            this.advance();
            return true;
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

    /** The token `offset` places ahead of the current one (EOF past the end). */
    private peekAt(offset: number): Token {
        const i = this.current + offset;
        return i < this.tokens.length ? this.tokens[i] : this.tokens[this.tokens.length - 1];
    }

    private previous(): Token {
        return this.tokens[this.current - 1];
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) return this.advance();
        throw this.error(this.peek(), message);
    }

    /** Record a syntax error. Callers that cannot continue the current rule throw the result. */
    private error(token: Token, message: string): ParseError {
        const err = new ParseError(token, message);
        this.errors.push(err);
        return err;
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
    /** Every syntax error in the source, in order; set on the error thrown by Parser.parse(). */
    errors: ParseError[] = [];

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

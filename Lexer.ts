import { TokenType } from "./enums/TokenType";
import type { Token } from "./interfaces/Token";
import { ParseError } from "./Parser";

export class Lexer {
  private source: string;
  private tokens: Token[] = [];
  private start = 0;
  private current = 0;
  private line = 1;
  private lineStart = 0;
  private templateBraceStack: number[] = [];

  private static keywords: { [key: string]: TokenType } = {
    'var': TokenType.VAR,
    'if': TokenType.IF,
    'else': TokenType.ELSE,
    'while': TokenType.WHILE,
    'for': TokenType.FOR,
    'print': TokenType.PRINT,
    'function': TokenType.FUNCTION,
    'return': TokenType.RETURN,
    'true': TokenType.TRUE,
    'false': TokenType.FALSE,
    'nil': TokenType.NIL,
    'try': TokenType.TRY,
    'catch': TokenType.CATCH,
    'break': TokenType.BREAK,
    'continue': TokenType.CONTINUE,
    'const': TokenType.CONST,
    'import': TokenType.IMPORT,
    'export': TokenType.EXPORT
  };

  constructor(source: string) {
    this.source = source;
  }

  scanTokens(): Token[] {
    while (!this.isAtEnd()) {
      this.start = this.current;
      this.scanToken();
    }

    const col = this.current - this.lineStart + 1;
    this.tokens.push({ type: TokenType.EOF, lexeme: "", literal: null, line: this.line, column: col });
    return this.tokens;
  }

  private scanToken() {
    const c = this.advance();
    switch (c) {
      case '(': this.addToken(TokenType.LEFT_PAREN, null, "("); break;
      case ')': this.addToken(TokenType.RIGHT_PAREN, null, ")"); break;
      case '{':
        if (this.templateBraceStack.length > 0) {
          this.templateBraceStack[this.templateBraceStack.length - 1]++;
        }
        this.addToken(TokenType.LEFT_BRACE, null, "{");
        break;
      case '}':
        if (this.templateBraceStack.length > 0) {
          const depth = this.templateBraceStack[this.templateBraceStack.length - 1];
          if (depth === 0) {
            this.templateBraceStack.pop();
            this.scanTemplateSegment(false);
            break;
          }
          this.templateBraceStack[this.templateBraceStack.length - 1] = depth - 1;
        }
        this.addToken(TokenType.RIGHT_BRACE, null, "}");
        break;
      case '[': this.addToken(TokenType.LEFT_BRACKET, null, "["); break;
      case ']': this.addToken(TokenType.RIGHT_BRACKET, null, "]"); break;
      case ',': this.addToken(TokenType.COMMA, null, ","); break;
      case ':': this.addToken(TokenType.COLON, null, ":"); break;
      case ';': this.addToken(TokenType.SEMICOLON, null, ";"); break;
      case '?': this.addToken(TokenType.QUESTION, null, "?"); break;
      case '.': this.addToken(TokenType.DOT, null, "."); break;
      case '+':
        if (this.match('=')) this.addToken(TokenType.PLUS_EQUAL, null, "+=");
        else this.addToken(TokenType.PLUS, null, "+");
        break;
      case '-':
        if (this.match('=')) this.addToken(TokenType.MINUS_EQUAL, null, "-=");
        else this.addToken(TokenType.MINUS, null, "-");
        break;
      case '*':
        if (this.match('=')) this.addToken(TokenType.STAR_EQUAL, null, "*=");
        else this.addToken(TokenType.STAR, null, "*");
        break;
      case '%':
        if (this.match('=')) this.addToken(TokenType.PERCENT_EQUAL, null, "%=");
        else this.addToken(TokenType.PERCENT, null, "%");
        break;
      case '/':
        if (this.match('=')) {
          this.addToken(TokenType.SLASH_EQUAL, null, "/=");
        } else if (this.match('/')) {
          while (this.peek() !== '\n' && !this.isAtEnd()) this.advance();
        } else if (this.match('*')) {
          this.blockComment();
        } else {
          this.addToken(TokenType.SLASH, null, "/");
        }
        break;
      case '=':
        if (this.match('=')) {
          this.addToken(TokenType.EQUAL_EQUAL, null, "==");
        } else {
          this.addToken(TokenType.EQUAL, null, "=");
        }
        break;
      case '!':
        if (this.match('=')) {
          this.addToken(TokenType.BANG_EQUAL, null, "!=");
        } else {
          this.addToken(TokenType.BANG, null, "!");
        }
        break;
      case '<':
        if (this.match('=')) {
          this.addToken(TokenType.LESS_EQUAL, null, "<=");
        } else {
          this.addToken(TokenType.LESS, null, "<");
        }
        break;
      case '>':
        if (this.match('=')) {
          this.addToken(TokenType.GREATER_EQUAL, null, ">=");
        } else {
          this.addToken(TokenType.GREATER, null, ">");
        }
        break;
      case '&':
        if (this.match('&')) {
          this.addToken(TokenType.AND, null, "&&");
        } else {
          throw new ParseError(this.makeToken(TokenType.EOF, c), `Unexpected character '${c}' at line ${this.line}`);
        }
        break;
      case '|':
        if (this.match('|')) {
          this.addToken(TokenType.OR, null, "||");
        } else {
          throw new ParseError(this.makeToken(TokenType.EOF, c), `Unexpected character '${c}' at line ${this.line}`);
        }
        break;
      case ' ':
      case '\r':
      case '\t':
        break;
      case '\n':
        this.line++;
        this.lineStart = this.current;
        break;
      case '"':
        this.string();
        break;
      case '`':
        this.scanTemplateSegment(true);
        break;
      default:
        if (this.isDigit(c)) {
          this.number(c);
        } else if (this.isAlpha(c)) {
          this.identifier();
        } else {
          throw new ParseError(this.makeToken(TokenType.EOF, c), `Unexpected character '${c}' at line ${this.line}`);
        }
        break;
    }
  }

  private blockComment() {
    const startLine = this.line;
    const startCol = this.start - this.lineStart + 1;
    while (!this.isAtEnd()) {
      if (this.peek() === '*' && this.peekNext() === '/') {
        this.advance();
        this.advance();
        return;
      }
      if (this.advance() === '\n') {
        this.line++;
        this.lineStart = this.current;
      }
    }
    throw new ParseError({ type: TokenType.EOF, lexeme: "/*", literal: null, line: startLine, column: startCol }, `Unterminated block comment at line ${startLine}.`);
  }

  private string() {
    const startCol = this.start - this.lineStart + 1;
    let out = "";
    while (this.peek() !== '"' && !this.isAtEnd()) {
      const ch = this.advance();
      if (ch === '\n') {
        this.line++;
        this.lineStart = this.current;
        out += '\n';
      } else if (ch === '\\') {
        out += this.readEscape(false);
      } else {
        out += ch;
      }
    }

    if (this.isAtEnd()) {
      throw new ParseError({ type: TokenType.STRING, lexeme: '"', literal: null, line: this.line, column: startCol }, `Unterminated string at line ${this.line}`);
    }

    // The closing ".
    this.advance();

    const text = this.source.substring(this.start, this.current);
    this.tokens.push({ type: TokenType.STRING, lexeme: text, literal: out, line: this.line, column: startCol });
  }

  private scanTemplateSegment(isHead: boolean) {
    const startCol = this.start - this.lineStart + 1;
    let out = "";
    while (!this.isAtEnd()) {
      if (this.peek() === '`') {
        this.advance();
        const text = this.source.substring(this.start, this.current);
        this.tokens.push({
          type: isHead ? TokenType.TEMPLATE_STRING : TokenType.TEMPLATE_TAIL,
          lexeme: text,
          literal: out,
          line: this.line,
          column: startCol,
        });
        return;
      }
      if (this.peek() === '$' && this.peekNext() === '{') {
        this.advance(); // $
        this.advance(); // {
        this.templateBraceStack.push(0);
        const text = this.source.substring(this.start, this.current);
        this.tokens.push({
          type: isHead ? TokenType.TEMPLATE_HEAD : TokenType.TEMPLATE_MIDDLE,
          lexeme: text,
          literal: out,
          line: this.line,
          column: startCol,
        });
        return;
      }
      const ch = this.advance();
      if (ch === '\n') {
        this.line++;
        this.lineStart = this.current;
        out += '\n';
      } else if (ch === '\\') {
        out += this.readEscape(true);
      } else {
        out += ch;
      }
    }
    throw new ParseError(
      { type: TokenType.TEMPLATE_STRING, lexeme: '`', literal: null, line: this.line, column: startCol },
      `Unterminated template literal at line ${this.line}.`
    );
  }

  private readEscape(allowTemplate: boolean): string {
    const escCol = (this.current - 1) - this.lineStart + 1;
    const escTok = (lex: string): Token => ({
      type: TokenType.STRING,
      lexeme: lex,
      literal: null,
      line: this.line,
      column: escCol,
    });
    if (this.isAtEnd()) {
      throw new ParseError(escTok('\\'), "Unterminated escape sequence.");
    }
    const next = this.advance();
    switch (next) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      case '"': return '"';
      case '`':
        if (allowTemplate) return '`';
        throw new ParseError(escTok('\\`'), "Unknown escape sequence '\\`'.");
      case '$':
        if (allowTemplate) return '$';
        throw new ParseError(escTok('\\$'), "Unknown escape sequence '\\$'.");
      case 'u': {
        if (this.peek() !== '{') {
          throw new ParseError(escTok('\\u'), "Invalid Unicode escape; expected \\u{...}.");
        }
        this.advance(); // '{'
        let hex = "";
        while (!this.isAtEnd() && this.peek() !== '}') {
          const h = this.advance();
          if (!this.isHexDigit(h)) {
            throw new ParseError(escTok(`\\u{${hex}${h}`), "Invalid hexadecimal digit in Unicode escape.");
          }
          hex += h;
          if (hex.length > 6) {
            throw new ParseError(escTok(`\\u{${hex}`), "Unicode escape out of range.");
          }
        }
        if (this.isAtEnd() || this.peek() !== '}') {
          throw new ParseError(escTok(`\\u{${hex}`), "Unterminated Unicode escape.");
        }
        this.advance(); // '}'
        if (hex.length === 0) {
          throw new ParseError(escTok('\\u{}'), "Empty Unicode escape.");
        }
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          throw new ParseError(escTok(`\\u{${hex}}`), "Invalid Unicode code point in escape sequence.");
        }
        return String.fromCodePoint(cp);
      }
      default:
        throw new ParseError(escTok(`\\${next}`), `Unknown escape sequence '\\${next}'.`);
    }
  }

  private number(firstChar: string) {
    if (firstChar === '0' && (this.peek() === 'x' || this.peek() === 'X')) {
      this.advance();
      if (!this.isHexDigit(this.peek())) {
        throw new ParseError(this.makeToken(TokenType.NUMBER), `Invalid hex literal at line ${this.line}.`);
      }
      while (this.isHexDigit(this.peek())) this.advance();
      const text = this.source.substring(this.start, this.current);
      this.addToken(TokenType.NUMBER, parseInt(text.slice(2), 16), text);
      return;
    }

    while (this.isDigit(this.peek())) this.advance();

    // Look for a fractional part.
    if (this.peek() === '.' && this.isDigit(this.peekNext())) {
      this.advance();
      while (this.isDigit(this.peek())) this.advance();
    }

    // Look for scientific exponent part: 1e3, 1.5e-2, 2E+5
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.advance();
      if (this.peek() === '+' || this.peek() === '-') {
        this.advance();
      }
      if (!this.isDigit(this.peek())) {
        throw new ParseError(this.makeToken(TokenType.NUMBER), `Invalid exponent in number literal at line ${this.line}.`);
      }
      while (this.isDigit(this.peek())) this.advance();
    }

    const text = this.source.substring(this.start, this.current);
    this.addToken(TokenType.NUMBER, parseFloat(text), text);
  }

  private identifier() {
    while (this.isAlphaNumeric(this.peek())) this.advance();

    const text = this.source.substring(this.start, this.current);
    let type = Lexer.keywords[text];
    if (type == null) type = TokenType.IDENTIFIER;
    this.addToken(type, null, text);
  }

  private match(expected: string): boolean {
    if (this.isAtEnd()) return false;
    if (this.source.charAt(this.current) !== expected) return false;

    this.current++;
    return true;
  }

  private peek(): string {
    if (this.isAtEnd()) return '\0';
    return this.source.charAt(this.current);
  }

  private peekNext(): string {
    if (this.current + 1 >= this.source.length) return '\0';
    return this.source.charAt(this.current + 1);
  }

  private isAlpha(c: string): boolean {
    return (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      c === '_';
  }

  private isAlphaNumeric(c: string): boolean {
    return this.isAlpha(c) || this.isDigit(c);
  }

  private isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
  }

  private isHexDigit(c: string): boolean {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }

  private isAtEnd(): boolean {
    return this.current >= this.source.length;
  }

  private advance(): string {
    return this.source.charAt(this.current++);
  }

  private makeToken(type: TokenType, lexeme?: string): Token {
    const text = lexeme !== undefined ? lexeme : this.source.substring(this.start, this.current);
    const col = this.start - this.lineStart + 1;
    return { type, lexeme: text, literal: null, line: this.line, column: col };
  }

  private addToken(type: TokenType, literal: any = null, lexeme?: string) {
    const text = lexeme !== undefined ? lexeme : this.source.substring(this.start, this.current);
    const col = this.start - this.lineStart + 1;
    this.tokens.push({ type, lexeme: text, literal, line: this.line, column: col });
  }
}

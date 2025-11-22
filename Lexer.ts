import { TokenType } from "./enums/TokenType";
import type { Token } from "./interfaces/Token";

export class Lexer {
    private source: string;
    private tokens: Token[] = [];
    private start = 0;
    private current = 0;
    private line = 1;
  
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
      'nil': TokenType.NIL
    };
  
    constructor(source: string) {
      this.source = source;
    }
  
    scanTokens(): Token[] {
      while (!this.isAtEnd()) {
        this.start = this.current;
        this.scanToken();
      }
  
      this.tokens.push({ type: TokenType.EOF, lexeme: "", literal: null, line: this.line });
      return this.tokens;
    }
  
    private scanToken() {
      const c = this.advance();
      switch (c) {
        case '(': this.addToken(TokenType.LEFT_PAREN); break;
        case ')': this.addToken(TokenType.RIGHT_PAREN); break;
        case '{': this.addToken(TokenType.LEFT_BRACE); break;
        case '}': this.addToken(TokenType.RIGHT_BRACE); break;
        case ',': this.addToken(TokenType.COMMA); break;
        case ';': this.addToken(TokenType.SEMICOLON); break;
        case '+': this.addToken(TokenType.PLUS); break;
        case '-': this.addToken(TokenType.MINUS); break;
        case '*': this.addToken(TokenType.STAR); break;
        case '/':
          if (this.match('/')) {
            // Comment goes until the end of the line
            while (this.peek() !== '\n' && !this.isAtEnd()) this.advance();
          } else {
            this.addToken(TokenType.SLASH);
          }
          break;
        case '=':
          this.addToken(this.match('=') ? TokenType.EQUAL_EQUAL : TokenType.EQUAL);
          break;
        case '!':
          this.addToken(this.match('=') ? TokenType.BANG_EQUAL : TokenType.BANG);
          break;
        case '<':
          this.addToken(this.match('=') ? TokenType.LESS_EQUAL : TokenType.LESS);
          break;
        case '>':
          this.addToken(this.match('=') ? TokenType.GREATER_EQUAL : TokenType.GREATER);
          break;
        case '&':
          if (this.match('&')) {
            this.addToken(TokenType.AND);
          }
          break;
        case '|':
          if (this.match('|')) {
            this.addToken(TokenType.OR);
          }
          break;
        case ' ':
        case '\r':
        case '\t':
          // Ignore whitespace
          break;
        case '\n':
          this.line++;
          break;
        case '"': this.string(); break;
        default:
          if (this.isDigit(c)) {
            this.number();
          } else if (this.isAlpha(c)) {
            this.identifier();
          } else {
            throw new Error(`Unexpected character '${c}' at line ${this.line}`);
          }
          break;
      }
    }
  
    private string() {
      while (this.peek() !== '"' && !this.isAtEnd()) {
        if (this.peek() === '\n') this.line++;
        this.advance();
      }
  
      if (this.isAtEnd()) {
        throw new Error(`Unterminated string at line ${this.line}`);
      }
  
      // The closing ".
      this.advance();
  
      // Trim the surrounding quotes.
      const value = this.source.substring(this.start + 1, this.current - 1);
      this.addToken(TokenType.STRING, value);
    }
  
    private number() {
      while (this.isDigit(this.peek())) this.advance();
  
      // Look for a fractional part.
      if (this.peek() === '.' && this.isDigit(this.peekNext())) {
        // Consume the "."
        this.advance();
  
        while (this.isDigit(this.peek())) this.advance();
      }
  
      this.addToken(TokenType.NUMBER, parseFloat(this.source.substring(this.start, this.current)));
    }
  
    private identifier() {
      while (this.isAlphaNumeric(this.peek())) this.advance();
  
      const text = this.source.substring(this.start, this.current);
      let type = Lexer.keywords[text];
      if (type == null) type = TokenType.IDENTIFIER;
      this.addToken(type);
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
  
    private isAtEnd(): boolean {
      return this.current >= this.source.length;
    }
  
    private advance(): string {
      return this.source.charAt(this.current++);
    }
  
    private addToken(type: TokenType, literal: any = null) {
      const text = this.source.substring(this.start, this.current);
      this.tokens.push({ type, lexeme: text, literal, line: this.line });
    }
  }

/*
  // Example usage:
  const source = `
  var x = 10;
  while (x > 0) {
      print(x);
      x = x - 1;
  }
  
  function add(a, b) {
      return a + b;
  }
  
  var result = add(5, 3);
  print(result);
  `;
  
  const lexer = new Lexer(source);
  const tokens = lexer.scanTokens();
  console.log(tokens);
*/
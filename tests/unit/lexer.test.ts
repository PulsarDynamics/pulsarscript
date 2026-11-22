import { describe, expect, test } from "bun:test";
import { Lexer } from "../../Lexer";
import { TokenType as T } from "../../enums/TokenType";

const types = (src: string) => new Lexer(src).scanTokens().map((t) => t.type);
const tokens = (src: string) => new Lexer(src).scanTokens();

describe("lexer", () => {
  test("ends every token stream with EOF", () => {
    expect(types("")).toEqual([T.EOF]);
    expect(types("1").at(-1)).toBe(T.EOF);
  });

  test("single and double character operators", () => {
    expect(types("+ - * / = == != < <= > >= ! && ||")).toEqual([
      T.PLUS, T.MINUS, T.STAR, T.SLASH, T.EQUAL, T.EQUAL_EQUAL, T.BANG_EQUAL,
      T.LESS, T.LESS_EQUAL, T.GREATER, T.GREATER_EQUAL, T.BANG, T.AND, T.OR, T.EOF,
    ]);
  });

  test("delimiters", () => {
    expect(types("( ) { } [ ] , : ;")).toEqual([
      T.LEFT_PAREN, T.RIGHT_PAREN, T.LEFT_BRACE, T.RIGHT_BRACE, T.LEFT_BRACKET, T.RIGHT_BRACKET,
      T.COMMA, T.COLON, T.SEMICOLON, T.EOF,
    ]);
  });

  test("keywords versus identifiers", () => {
    expect(types("var if else while for function return print nil true false try catch")).toEqual([
      T.VAR, T.IF, T.ELSE, T.WHILE, T.FOR, T.FUNCTION, T.RETURN, T.PRINT, T.NIL, T.TRUE, T.FALSE, T.TRY, T.CATCH, T.EOF,
    ]);
    const [id] = tokens("variable");
    expect(id.type).toBe(T.IDENTIFIER);
    expect(id.lexeme).toBe("variable");
  });

  test("number literals carry numeric values", () => {
    const [i, f] = tokens("42 3.25");
    expect(i.type).toBe(T.NUMBER);
    expect(i.literal).toBe(42);
    expect(f.literal).toBe(3.25);
  });

  test("a trailing dot is not part of a number", () => {
    // "1." lexes as NUMBER(1) and then '.', which is not a valid character.
    expect(() => tokens("1.")).toThrow(/Unexpected character '\.'/);
  });

  test("string literals drop their quotes", () => {
    const [s] = tokens('"hello world"');
    expect(s.type).toBe(T.STRING);
    expect(s.literal).toBe("hello world");
  });

  test("strings have no escape sequences in v0", () => {
    // SPEC v0: a backslash is an ordinary character; escapes arrive in Phase 2.
    const [s] = tokens('"a\\nb"');
    expect(s.literal).toBe("a\\nb");
  });

  test("line comments are skipped", () => {
    expect(types("1 // comment ( ] \n2")).toEqual([T.NUMBER, T.NUMBER, T.EOF]);
  });

  test("tracks line numbers across newlines and multi-line strings", () => {
    const toks = tokens('a\nb\n"x\ny"\nc');
    expect(toks.map((t) => t.line)).toEqual([1, 2, 4, 5, 5]);
  });

  test("unterminated string is an error", () => {
    expect(() => tokens('"abc')).toThrow(/Unterminated string/);
  });

  test("unexpected character is an error", () => {
    expect(() => tokens("1 % 2")).toThrow(/Unexpected character '%'/);
  });
});

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
    // "1." lexes as NUMBER(1) and then DOT (member access, SPEC v0.5).
    const ts = tokens("1.");
    expect(ts[0].type).toBe(T.NUMBER);
    expect(ts[1].type).toBe(T.DOT);
  });

  test("compound assignment and modulo operators", () => {
    const types = tokens("a += 1; b -= 1; c *= 1; d /= 1; e %= 1; f % 2").map((t) => t.type);
    for (const t of [T.PLUS_EQUAL, T.MINUS_EQUAL, T.STAR_EQUAL,
      T.SLASH_EQUAL, T.PERCENT_EQUAL, T.PERCENT]) {
      expect(types).toContain(t);
    }
  });

  test("string literals drop their quotes", () => {
    const [s] = tokens('"hello world"');
    expect(s.type).toBe(T.STRING);
    expect(s.literal).toBe("hello world");
  });

  test("string escape sequences and unknown-escape errors (LANG-03)", () => {
    expect(tokens('"a\\nb\\tc\\rd\\\\\\"\\u{1F600}"')[0].literal).toBe("a\nb\tc\rd\\\"\u{1F600}");
    expect(() => tokens('"bad\\q"')).toThrow(/Unknown escape sequence/);
  });

  test("tracks token column numbers (LANG-06)", () => {
    const toks = tokens("var x = 42;\n  print(x);");
    expect(toks[0].column).toBe(1);  // var
    expect(toks[1].column).toBe(5);  // x
    expect(toks[5].column).toBe(3);  // print on line 2
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
    expect(() => tokens("1 @ 2")).toThrow(/Unexpected character '@'/);
  });
});

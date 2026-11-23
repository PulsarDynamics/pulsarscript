export enum TokenType {
    // Keywords
    VAR = 'VAR',
    IF = 'IF',
    ELSE = 'ELSE',
    WHILE = 'WHILE',
    NIL = "NIL",
    FOR = "FOR",
    PRINT = 'PRINT',
    FUNCTION = 'FUNCTION',
    RETURN = 'RETURN',
    TRY = "TRY",
    CATCH = "CATCH",
    BREAK = "BREAK",
    CONTINUE = "CONTINUE",
    CONST = "CONST",
    IMPORT = "IMPORT",
    EXPORT = "EXPORT",

    // Literals
    IDENTIFIER = 'IDENTIFIER',
    NUMBER = 'NUMBER',
    STRING = 'STRING',
    TEMPLATE_STRING = 'TEMPLATE_STRING',
    TEMPLATE_HEAD = 'TEMPLATE_HEAD',
    TEMPLATE_MIDDLE = 'TEMPLATE_MIDDLE',
    TEMPLATE_TAIL = 'TEMPLATE_TAIL',

    // Logic
    FALSE = "FALSE",
    TRUE = "TRUE",

    // Operators
    PLUS = 'PLUS',
    MINUS = 'MINUS',
    STAR = 'STAR',
    SLASH = 'SLASH',
    PERCENT = 'PERCENT',
    PLUS_EQUAL = 'PLUS_EQUAL',
    MINUS_EQUAL = 'MINUS_EQUAL',
    STAR_EQUAL = 'STAR_EQUAL',
    SLASH_EQUAL = 'SLASH_EQUAL',
    PERCENT_EQUAL = 'PERCENT_EQUAL',
    EQUAL = 'EQUAL',
    EQUAL_EQUAL = 'EQUAL_EQUAL',
    BANG_EQUAL = 'BANG_EQUAL',
    GREATER = 'GREATER',
    GREATER_EQUAL = 'GREATER_EQUAL',
    LESS = 'LESS',
    LESS_EQUAL = 'LESS_EQUAL',
    AND = 'AND',
    OR = 'OR',
    BANG = 'BANG',

    // Delimiters
    LEFT_PAREN = 'LEFT_PAREN',
    RIGHT_PAREN = 'RIGHT_PAREN',
    LEFT_BRACE = 'LEFT_BRACE',
    RIGHT_BRACE = 'RIGHT_BRACE',
    LEFT_BRACKET = 'LEFT_BRACKET',
    RIGHT_BRACKET = 'RIGHT_BRACKET',
    COMMA = 'COMMA',
    DOT = 'DOT',
    COLON = 'COLON',
    SEMICOLON = 'SEMICOLON',
    QUESTION = 'QUESTION',

    // Other
    EOF = 'EOF'
}

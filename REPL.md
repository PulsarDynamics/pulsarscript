# PulsarScript REPL

## Starting the REPL

To start the interactive REPL:

```bash
bun run repl
```

Or directly:

```bash
bun repl.ts
```

## Features

### Interactive Shell
- Line-by-line code execution
- Persistent state (variables and functions remain defined)
- Colorized output for better readability
- Command history

### Special Commands

- `.help` - Display help information
- `.exit` or `.quit` - Exit the REPL
- `.clear` - Clear the screen
- `.reset` - Reset the interpreter state (clear all variables and functions)
- `.strict [on|off]` - Toggle checked built-in arguments (on by default)
- `.history` - Show command history
- `.multiline` - Enter multi-line mode for complex code blocks

### Strict Mode

Strict mode is on by default and matches the production VM:
- Arithmetic on non-numbers is a runtime error (`true + 1`)
- `+` concatenates when either side is a string (`1 + "2"` is `"12"`)
- Built-in functions check their argument types

`.strict off` makes built-ins coerce their arguments instead. It exists for old embedders and is not part of the language.

### Multi-line Mode

For defining functions or complex blocks:

```
» .multiline
Entering multi-line mode. Enter an empty line to execute.
... function factorial(n) {
...   if (n <= 1) {
...     return 1;
...   }
...   return n * factorial(n - 1);
... }
...
```

## Example Session

```pulsarscript
» var greeting = "Hello";
» print(greeting);
Hello

» function greet(name) { print(greeting + ", " + name + "!"); }
» greet("World");
Hello, World!

» var x = 10;
» var y = 20;
» print(x + y);
30

» for (var i = 0; i < 3; i = i + 1) { print(i); }
0
1
2

» print(typeOf(x));
number

» print(len("PulsarScript"));
10

» print(abs(-42));
42

» .history
History:
  1. var greeting = "Hello";
  2. print(greeting);
  3. function greet(name) { print(greeting + ", " + name + "!"); }
  4. greet("World");
  5. var x = 10;
  6. var y = 20;
  7. print(x + y);
  8. for (var i = 0; i < 3; i = i + 1) { print(i); }
  9. print(typeOf(x));
  10. print(len("PulsarScript"));
  11. print(abs(-42));

» .exit
Goodbye!
```

## Error Handling

The REPL provides detailed error messages with source context:

```pulsarscript
» var x = true + 1;

Runtime Error at line 1:
Operands must be two numbers, or include a string.

>    1 | var x = true + 1;
                     ^
```

## Tips

1. **Testing Code Snippets**: The REPL is perfect for quickly testing PulsarScript expressions
2. **Learning**: Use `.help` to explore available commands
3. **Debugging**: Use `.reset` to start fresh if you get into an inconsistent state
4. **Complex Code**: Use `.multiline` for functions or control structures
5. **Type Safety**: Toggle `.strict on` to catch type errors early

## Built-in Functions Available

### Type/Conversion
- `typeOf(value)` - Get type as string
- `number(value)` - Convert to number
- `string(value)` - Convert to string

### Math
- `abs(n)`, `floor(n)`, `ceil(n)`, `round(n)`
- `sqrt(n)`, `pow(base, exp)`
- `min(a, b)`, `max(a, b)`, `clamp(n, min, max)`

### String
- `len(str)` - String length
- `toUpper(str)`, `toLower(str)`, `trim(str)`
- `indexOf(str, substr)`, `substr(str, start, length)`
- `concat(...)` - Concatenate values

### Utility
- `clock()` - Current timestamp
- `random()` - Random number [0, 1)
- `randomInt(min, max)` - Random integer

### Safe Parsing
- `parseInt(str, base)` - Parse integer
- `parseFloat(str)` - Parse float
- `toNumberOr(value, default)` - Convert with fallback
- `isInteger(n)`, `isFinite(n)` - Type checks

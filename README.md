# PulsarScript

A dynamically-typed scripting language with optional strict typing, built-in functions, and comprehensive error reporting.

## Features

- ✨ Dynamic and strict typing modes
- 🔧 Rich standard library (math, strings, type checking)
- 🎯 Detailed error messages with source context and call stacks
- 🔄 For/while loops, functions, and control flow
- 💻 Interactive REPL for live coding
- 📦 Built with Bun and TypeScript

## Installation

```bash
bun install
```

## Embedding / Host API

### TypeScript Interpreter
- Use `createInterpreter(options)` (see `host.ts`) to embed the interpreter with host bridges (`ipc`, `io`, modules).
- Use `runSource(source, options)` to compile + run code and get structured errors instead of throwing.

### Go VM (Recommended for Production)

Compile PulsarScript to bytecode for the Go VM:

```bash
# Compile script to bytecode
bun run compile.ts script.poo script.json

# Compile with syntax check only
bun run compile.ts -c script.poo

# Compile with source mapping for better error messages
bun run compile.ts -s script.poo script.json
```

Run with the Go VM:

```bash
# Run script
go run ./cmd/vmrun script.json

# Disassemble bytecode
go run ./cmd/vmrun -disasm script.json

# Step-by-step debugging
go run ./cmd/vmrun -step script.json

# List registered handlers
go run ./cmd/vmrun -inspect script.json
```

### Supported Features (Bytecode/Go VM)
- ✅ Variables, functions, control flow (if/while/for)
- ✅ Try/catch exception handling
- ✅ Arrays: `[1, 2, 3]`, array host calls
- ✅ Objects: `{name: "value"}`, object host calls  
- ✅ 40+ host calls (math, filesystem, KV, IPC, events)
- ✅ Source mapping for error line numbers
- ✅ Configurable stack/memory limits

Host bridges:
- `ipc`: `{ send(envelope), sendAsync?(envelope), defaultDeviceId?, defaultProcessId? }`
- `io`: `{ readFile, writeFile, listDir, kvGet?, kvSet?, kvDelete? }`
- Modules: pass `modules` map or `moduleLoader` in `Interpreter` options.

## Usage

### Run the Test Program

```bash
bun run index.ts
```

### Start the REPL

```bash
bun run repl
```

Interactive shell for live coding. See [REPL.md](./REPL.md) for full documentation.

### Test Error Reporting

```bash
bun run test-errors.ts
```

Demonstrates enhanced error reporting with source context and call stacks.

## Language Features

### Variables and Functions

```javascript
var x = 10;
var message = "Hello, World!";

function add(a, b) {
  return a + b;
}

print(add(5, 3)); // 8
```

### Control Flow

```javascript
// If/else
if (x > 5) {
  print("Greater");
} else {
  print("Smaller");
}

// While loop
var i = 0;
while (i < 5) {
  print(i);
  i = i + 1;
}

// For loop
for (var j = 0; j < 5; j = j + 1) {
  print(j);
}
```

### Strict Mode

```javascript
// Enable strict typing
var result = 1 + "2"; // Error in strict mode!

// Use concat for explicit string concatenation
var result = concat(1, "2", " items"); // "12 items"
```

### Built-in Functions

**Type & Conversion:**
- `typeOf(value)`, `number(value)`, `string(value)`

**Math:**
- `abs()`, `floor()`, `ceil()`, `round()`, `sqrt()`, `pow()`
- `min()`, `max()`, `clamp()`
- `random()`, `randomInt(min, max)`

**Strings:**
- `len()`, `toUpper()`, `toLower()`, `trim()`
- `indexOf()`, `substr()`, `concat()`

**Safe Parsing:**
- `parseInt()`, `parseFloat()`, `toNumberOr()`
- `isInteger()`, `isFinite()`

## Error Reporting

PulsarScript provides detailed error messages with source context:

```
Runtime Error at line 5:
Division by zero.

     4 | function divide(a, b) {
>    5 |   return a / b;
                   ^
     6 | }

Call stack:
  at divide (line 4)
  in calculate (line 8)
```

## Project Structure

```
pulsarscript/
├── index.ts              # Main test program
├── repl.ts              # Interactive REPL
├── Lexer.ts             # Tokenization
├── Parser.ts            # AST generation
├── SemanticAnalyzer.ts  # Static analysis
├── Interpreter.ts       # Execution engine
├── ErrorReporter.ts     # Error formatting
├── classes/             # AST node classes
├── interfaces/          # Type definitions
└── enums/               # Token types
```

## Documentation

- [REPL Guide](./REPL.md) - Interactive shell documentation
- [Error Reporting](./ERROR_REPORTING.md) - Enhanced error system details

## Development

Built using [Bun](https://bun.sh) v1.1.12 - a fast all-in-one JavaScript runtime.

### Running Tests

```bash
bun run test          # Main test program
bun run test-errors   # Error reporting tests
```

## License

MIT

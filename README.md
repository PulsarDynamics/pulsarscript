# PulsarScript

A dynamically-typed scripting language with checked arithmetic, built-in functions, and comprehensive error reporting. The language is defined by [SPEC.md](SPEC.md).

## Features

- ✨ Dynamic typing with checked arithmetic; arrays and objects as values
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
- ✅ 54 built-ins and host calls, listed in [`hostapi.json`](hostapi.json) (SPEC §8); unknown names fail at compile time
- ✅ Source mapping for error line numbers
- ✅ Default step, time and call-depth budgets (SPEC §7)

Interpreter options (`new Interpreter({...})`, `runSource(src, {...})`):
- `ipc`: `{ send(envelope), defaultDeviceId?, defaultProcessId? }`
- `io`: `{ readFile, writeFile, listDir, kvGet?, kvSet?, kvDelete?, stat?, exists?, deleteFile? }`
- `events`: `{ emit(payload), poll() }`
- `limits`: `{ maxSteps, timeoutMs, maxCallDepth }` (defaults 10,000,000 / 10,000 ms / 256; `0` or `Infinity` lifts one)

Handlers registered with `registerHandler(name, fn)` can be called from TypeScript with `interpreter.callHandler(name, args)`.

## Usage

### Run the Demo Program

```bash
bun run demo          # set PULSARSCRIPT_DUMP=1 to also write tokens.json / statements.json
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

### Types and `+`

```javascript
var label = "items: " + 3;       // "items: 3" (+ concatenates when either side is a string)
var bad = true + 1;              // runtime error: arithmetic needs numbers
var list = arrayPush([1], 2);    // [1, 2] (arrays and objects are values; assign the result)
try { var x = 1 / 0; } catch (e) { print(objGet(e, "line")); }   // e is {kind, line, message}
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
├── SPEC.md               # Language specification (v0) and defect register
├── index.ts              # Demo program
├── repl.ts              # Interactive REPL
├── compile.ts           # Bytecode compiler CLI (for the Go VM)
├── BytecodeCompiler.ts  # AST -> bytecode
├── Bytecode.ts          # Opcodes and chunk format
├── Lexer.ts             # Tokenization
├── Parser.ts            # AST generation
├── SemanticAnalyzer.ts  # Static analysis
├── Interpreter.ts       # Execution engine
├── ErrorReporter.ts     # Error formatting
├── classes/             # AST node classes
├── interfaces/          # Type definitions
├── enums/               # Token types
├── examples/            # Sample .poo scripts
└── tests/
    ├── unit/            # bun test: lexer, parser, compiler
    ├── golden/          # golden bytecode (UPDATE_GOLDEN=1 bun test to regenerate)
    └── conformance/     # language conformance suite (.poo + .expected)
```

## Documentation

- [Language Specification](./SPEC.md) - Grammar, semantics, built-ins, bytecode format, known defects
- [REPL Guide](./REPL.md) - Interactive shell documentation
- [Error Reporting](./ERROR_REPORTING.md) - Enhanced error system details

## Development

Built with [Bun](https://bun.sh) 1.4 (pinned in CI) and TypeScript 5.6.

### Checks

```bash
bun install --frozen-lockfile
bun run typecheck     # tsc --noEmit, must be clean
bun test              # unit tests and golden bytecode
bun run conformance   # conformance suite on the interpreter
```

To also run the conformance suite on the Go VM, build `vmrun` from pulsaros-api and point at it:

```bash
(cd ../pulsaros-api && go build -o /tmp/vmrun ./cmd/vmrun)
PULSARSCRIPT_VMRUN=/tmp/vmrun bun run conformance -- --require-vm
```

### Changing the language

1. Update [SPEC.md](./SPEC.md).
2. Add or change cases in `tests/conformance/` (`<name>.poo` + `<name>.expected`).
3. Implement it. Known gaps are marked `// @xfail <runtime> <defect> <note>` in the case; when a fix makes one pass, the runner reports XPASS and fails until you remove the marker.

## License

MIT

# PulsarScript Quick Reference

## Starting the REPL
```bash
bun run repl
```

## REPL Commands
| Command | Description |
|---------|-------------|
| `.help` | Show help message |
| `.exit` | Exit REPL |
| `.clear` | Clear screen |
| `.reset` | Reset interpreter |
| `.strict [on\|off]` | Toggle checked built-in arguments (on by default) |
| `.history` | Show history |
| `.multiline` | Multi-line input mode |

## Syntax

### Variables
```javascript
var x = 10;
var name = "Alice";
var flag = true;
var nothing = nil;
```

### Operators
```javascript
+ - * /           // Arithmetic
== != < > <= >=  // Comparison
&& ||            // Logical
!                // Not
```

### Functions
```javascript
function greet(name) {
  return "Hello, " + name;
}

var result = greet("World");
```

### Control Flow
```javascript
// If-else
if (x > 0) {
  print("Positive");
} else {
  print("Non-positive");
}

// While
while (x > 0) {
  print(x);
  x = x - 1;
}

// For
for (var i = 0; i < 5; i = i + 1) {
  print(i);
}
```

## Built-in Functions

### Type/Conversion
```javascript
typeOf(123)        // "number"
number("42")       // 42
string(123)        // "123"
```

### Math
```javascript
abs(-5)            // 5
floor(3.9)         // 3
ceil(3.1)          // 4
round(3.5)         // 4
sqrt(16)           // 4
pow(2, 3)          // 8
min(5, 3)          // 3
max(5, 3)          // 5
clamp(10, 0, 5)    // 5
```

### Strings
```javascript
len("hello")                    // 5
toUpper("hello")                // "HELLO"
toLower("WORLD")                // "world"
trim("  hi  ")                  // "hi"
indexOf("hello", "ll")          // 2
substr("hamburger", 3, 5)       // "burge"
concat("Hello", " ", "World")   // "Hello World"
```

### Random
```javascript
clock()            // Current timestamp
random()           // Random [0, 1)
randomInt(1, 6)    // Random int [1, 6]
```

### Safe Parsing
```javascript
parseInt("42", 10)      // 42
parseInt("1A", 16)      // 26
parseFloat("3.14")      // 3.14
toNumberOr("bad", 0)    // 0
isInteger(10)           // true
isFinite(1/0)           // false (in non-strict)
```

### IPC Helpers (requires host IPC bridge)
```javascript
ipcNonce()                                 // Generates a random nonce
ipcSetContext("device-1", "process-1")     // Sets default device/process for future IPC calls
var env = ipcEnvelope("net.scan", "scan", { worldZone: "airport" })
var res = ipcSend("net.scan", "scan", { worldZone: "airport" }) // Sends via host bridge, returns result or throws on error
ipcSendRaw(env)                            // Send a pre-built envelope (fills defaults if missing)
ipcSendAsync("net.scan", "scan", { worldZone: "airport" }, 
  function (res) { print(res); }, 
  function (err) { print(err.message); })  // Async send with callbacks (uses host sendAsync if available)
```

### Error Handling Helper
```javascript
tryCatch(
  function () { return riskyCall(); },
  function (err) { print(concat("Error: ", err.message)); return nil; }
);

// Structured try/catch syntax
try {
  print("do risky stuff");
} catch (e) {
  print(concat("Caught: ", e.message));
}
```

### Modules (host-provided or dynamic)
```javascript
// Host preloads modules via interpreter options; import them at runtime:
var utils = importModule("utils");
print(utils.version);

// Dynamically register a module
registerModule("math2", { double: function (x) { return x + x; } });
var m2 = importModule("math2");
print(m2.double(10)); // 20
```

### Sandboxed I/O (host-provided IO bridge)
```javascript
var contents = fsRead("Documents/readme.txt");   // string or nil
fsWrite("Documents/out.txt", "hello");           // returns true/false
var entries = fsList("Documents");               // [{ name, isDir, size? }, ...]
kvSet("key", 123);                               // if kv storage enabled
print(kvGet("key"));                             // 123
kvDelete("key");
```

## Types

```javascript
1 + "2"                    // "12" (+ concatenates when either side is a string)
true + 1                   // ERROR: arithmetic needs numbers
toUpper(123)               // ERROR: wrong argument type
toUpper(string(123))       // "123" (OK)
[1, 2] == [1, 2]           // true (arrays and objects compare by contents)
```

`.strict off` in the REPL makes built-ins coerce their arguments instead of failing. It exists for old embedders and is not part of the language.

## Examples

### Factorial
```javascript
function factorial(n) {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

print(factorial(5));  // 120
```

### FizzBuzz
```javascript
for (var i = 1; i <= 20; i = i + 1) {
  if (i % 15 == 0) {
    print("FizzBuzz");
  } else if (i % 3 == 0) {
    print("Fizz");
  } else if (i % 5 == 0) {
    print("Buzz");
  } else {
    print(i);
  }
}
```

### String Manipulation
```javascript
var text = "  Hello, World!  ";
print(len(text));              // 17
print(len(trim(text)));        // 13
print(toUpper(trim(text)));    // "HELLO, WORLD!"
print(substr(text, 2, 5));     // "Hello"
```

### Type Checking
```javascript
function describe(value) {
  var t = typeOf(value);
  print(concat("Type: ", t, ", Value: ", string(value)));
}

describe(42);        // Type: number, Value: 42
describe("hello");   // Type: string, Value: hello
describe(true);      // Type: boolean, Value: true
```

## Error Handling

Errors show source context:
```
Runtime Error at line 3:
Division by zero.

     2 | var y = 0;
>    3 | var result = x / y;
                       ^
     4 | print(result);
```

With call stacks:
```
Call stack:
  at divide (line 5)
  in calculate (line 9)
```

## Tips

- Use `.multiline` for complex functions
- Use `.reset` if state gets confusing
- Use `.history` to review commands
- `arrayPush`, `objSet` and friends return a new value: write `a = arrayPush(a, x);`
- Use safe parsing (`parseInt`, `parseFloat`) for user input

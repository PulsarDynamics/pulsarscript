# PulsarScript Language Specification — v0

**Status:** v0.3 records the language **as it behaves today** (November 2026; D1–D7, D9, D10, D13–D17 and D19 fixed). v0.2 settled the value model; v0.3 makes `hostapi.json` the one registry of built-ins and host calls (§8), so unknown functions fail at compile time, and bounds every run by default (§7). Where today's behaviour is wrong or the two runtimes disagree, the rule says what the language *should* do and points to a defect (⚠ **Dn**). The [defect register](#12-defect-register) at the end lists all of them.

**Authority:** the conformance suite in `tests/conformance/` is the executable form of this document. A rule without a conformance case is not yet pinned. Every language change must update this file and add or adjust cases in the same pull request.

**Runtimes covered:**

| Name | Path | Role |
| --- | --- | --- |
| `vm` | `compile.ts` → JSON bytecode → Go VM (`pulsaros-api/internal/pulsarscriptvm`, `cmd/vmrun`) | Production runtime. Scripts in PulsarOS apps run here. |
| `interp` | `Lexer` → `Parser` → `SemanticAnalyzer` → `Interpreter` (TypeScript; `repl.ts`, `host.ts`) | Development runtime (REPL, embedding). Its future is decision A1 in the development plan. |

---

## 1. Source text

- Source files use the extension `.poo`, are UTF-8, and are read as a whole.
- **Whitespace:** space, tab, carriage return and newline separate tokens. Newlines also advance the line counter used in error messages.
- **Comments:** `//` to the end of the line. There are no block comments.
- **Statements end with `;`**, except block statements, `if`, `while`, `for`, `function` and `try` declarations.

## 2. Lexical grammar

### 2.1 Keywords

`var` `function` `return` `if` `else` `while` `for` `print` `try` `catch` `true` `false` `nil`

### 2.2 Identifiers

A letter or `_`, followed by letters, digits or `_`. Identifiers are case-sensitive. A keyword cannot be an identifier.

### 2.3 Number literals

Decimal digits with an optional fractional part: `42`, `3.25`, `0.5`. There are no exponents (`1e3`), hex, octal, binary or digit separators. A trailing dot (`1.`) is a lexical error. Numbers are IEEE-754 double precision.

`1e3` lexes as `1` followed by the identifier `e3`, which is a syntax error (fixed in D13: previously the statement was silently dropped).

### 2.4 String literals

Double-quoted: `"hello"`. Strings may span lines. In v0 there are **no escape sequences**: a backslash is an ordinary character, and a string cannot contain `"`. Escapes and template literals are planned for Phase 2. An unterminated string is a lexical error.

### 2.5 Operators and punctuation

`+ - * / ! = == != < <= > >= && || ( ) { } [ ] , : ;`

There is no `%`, `.`, `+=`/`-=`, `++`/`--` or ternary `?:` in v0. Any other character is a lexical error ("Unexpected character").

## 3. Values and types

| Type | Literal | `typeOf` | Notes |
| --- | --- | --- | --- |
| number | `42`, `3.25` | `"number"` | IEEE-754 double |
| string | `"text"` | `"string"` | immutable |
| boolean | `true`, `false` | `"boolean"` | |
| nil | `nil` | `"nil"` | the absence of a value; uninitialised variables and functions without a return value produce `nil` |
| array | `[1, "a", true]` | `"array"` | ordered list of any values |
| object | `{name: "x", n: 1}` | `"object"` | string keys to any values; keys in a literal are identifiers, a repeated key keeps the last value |

There are no function values in v0: functions cannot be stored in variables, passed as arguments or returned (planned for Phase 2).

### 3.1 Truthiness

`nil` and `false` are falsy. **Every other value is truthy, including `0` and `""`.**

### 3.2 Printing values

`print(expr)` writes one line. `string(v)`, `concat(…)` and `+` with a string use the same printed form.

- **Numbers** print as JavaScript prints them: the shortest form that round-trips, `5`, `3.5`, `0.30000000000000004`, `3628800`; exponent form from `1e21` up and below `1e-6` (`1e+21`, `1e-7`); `NaN`, `Infinity`, `-Infinity`. Negative zero prints as `0`. (Fixed on the `vm` in D14.)
- **Booleans** print as `true`/`false`, **nil** as `nil`, **strings** as their text without quotes.
- **Arrays** print as `[e1, e2]`: elements separated by `, `, strings inside quoted with JSON escapes. `[]` when empty.
- **Objects** print as `{k: v}` with keys in sorted order (by code unit). A key that is an identifier prints bare; any other key is quoted. Values follow the array rule. `{}` when empty.

```
print([1, "two", nil, [3.5]]);          // [1, "two", nil, [3.5]]
print({b: 2, a: "x"});                  // {a: "x", b: 2}
print(objSet({}, "with space", 1));     // {"with space": 1}
```

(Fixed on the `vm` in D17, which printed `<?>`; implemented on `interp` in D4.)

### 3.3 Arrays and objects are values

Arrays and objects have **value semantics**: no operation changes an existing array or object. The `array*`/`obj*` built-ins (§8) return a new array or object, so the result must be assigned:

```
var a = [1];
var b = arrayPush(a, 2);   // a is still [1]; b is [1, 2]
a = arrayPush(a, 3);       // to "append", assign the result
```

`arrayPop(a)` returns the last element (or `nil`) and does not shorten `a`; use `arraySlice(a, 0, arrayLen(a) - 1)` for the rest. There is no indexing syntax in v0 (`a[i]`, `o.k`). (D15: decided as value semantics, matching what the `vm` already did; the alternative, shared mutable references, would make every host boundary and handler call share state.)

## 4. Expressions

### 4.1 Precedence (lowest to highest)

| Level | Operators | Associativity |
| --- | --- | --- |
| Assignment | `=` | right |
| Logical OR | `\|\|` | left |
| Logical AND | `&&` | left |
| Equality | `==` `!=` | left |
| Comparison | `<` `<=` `>` `>=` | left |
| Additive | `+` `-` | left |
| Multiplicative | `*` `/` | left |
| Unary | `!` `-` | right |
| Call | `f(args)` | left |
| Primary | literals, identifiers, `( expr )`, array and object literals | |

### 4.2 Arithmetic

`+ - * /` on two numbers have IEEE-754 semantics, **except that division by zero is a runtime error** in both runtimes. Unary `-` negates a number.

**`+` concatenates when either operand is a string**, converting the other operand to its printed form (§3.2): `"a" + 1` → `"a1"`, `"v: " + nil` → `"v: nil"`, `"xs: " + [1]` → `"xs: [1]"`. `+` is left-associative, so `1 + 2 + "x"` is `"3x"` and `"x" + 1 + 2` is `"x12"`. (Fixed in D6.)

Any other arithmetic on a non-number, such as `true + 1` or `-"a"`, is a runtime error, and so is passing the wrong type to a built-in (`abs("x")`). `interp` keeps a `strictTypes: false` option for old embedders that coerces built-in arguments instead; it is off by default and outside the language.

### 4.3 Comparison and equality

`< <= > >=` compare two numbers. `==` and `!=` compare type and value, with **no type coercion**: `1 == "1"` is `false`, and `nil == false` is `false`. **Arrays and objects compare by contents**, recursively: `[1, [2]] == [1, [2]]` and `{a: 1, b: 2} == {b: 2, a: 1}` are `true`. `arrayIndexOf` uses the same equality.

### 4.4 Logical operators

`!x` is `true` when `x` is falsy. `a && b` and `a || b` always evaluate to `true` or `false` (never to an operand) and **short-circuit**: `b` is not evaluated when `a` decides the result. `&&` binds tighter than `||`. (Fixed in D16.)

### 4.5 Assignment

`name = expr` assigns to an existing variable and evaluates to the assigned value, so `a = b = 5` sets both. Assigning to an undeclared name is a compile-time error. (Fixed on the `vm` in D3; it used to create a global silently.)

Only plain identifiers are assignment targets in v0 (no `a[i] = v` or `o.k = v`; see §8 for host calls).

### 4.6 Calls

`name(arg, …)` calls a user function declared with `function` or a function in the registry (§8). At most 255 arguments. Only identifiers can be called. A user function with the same name as a built-in takes precedence.

**Calls are resolved at compile time.** A name that is neither a user function nor in the registry is a compile-time error (`Unknown function 'x'.`), and so is a wrong argument count for a built-in. Argument *types* are checked when the call runs. (Fixed in D3: unknown names used to compile as host calls that failed at runtime, where `try`/`catch` could swallow them.)

**Top-level functions are hoisted:** a call resolves to any function declared at the top level of the file, including one declared later and including calls made before the declaration. Functions declared inside a block are callable after their declaration within that block. (Fixed in D2.)


## 5. Statements

| Statement | Form | Notes |
| --- | --- | --- |
| Expression | `expr;` | value discarded |
| Print | `print(expr);` | writes one line (§3.2) |
| Variable | `var name;` / `var name = expr;` | without an initializer the value is `nil` |
| Block | `{ … }` | opens a scope |
| If | `if (cond) stmt` / `if (cond) stmt else stmt` | `else if` is an `if` in the else branch |
| While | `while (cond) stmt` | |
| For | `for (init; cond; incr) stmt` | each part optional; `init` may be a `var` scoped to the loop |
| Function | `function name(p1, p2) { … }` | top level or nested in blocks |
| Return | `return;` / `return expr;` | `return;` yields `nil` |
| Try/catch | `try { … } catch (e) { … }` | `(e)` may be omitted |

There is no `break`, `continue`, `switch`, `do…while`, `for…of`, `const` or `let` in v0.

A syntax error stops compilation. The parser recovers after each error so that **every** syntax error in the file is reported in one pass, each with its line. (Fixed in D13: errors used to be swallowed and the statement silently dropped.)

## 6. Scope and variables

- **Lexical block scoping.** Every block, function body and `for` loop opens a scope. An inner declaration shadows outer ones until the scope ends.
- Declaring the same name twice in one scope is an error.
- **Top-level variables are globals**: a `var` outside every function, block and `try` block. Function bodies may read and assign globals declared anywhere in the file; at the top level a global must be declared before it is used. (Fixed in D1: the `vm` used to compile them as locals that functions could not see.)
- A `var` inside a block, function body, `for` initializer or `try` block is local.

- Function parameters and `var`s inside a function are local to each call.
- There are no closures in v0. A nested function cannot capture the enclosing function's locals.

## 7. Errors

| Kind | When | Effect |
| --- | --- | --- |
| Lexical | unexpected character, unterminated string | compilation fails |
| Syntax | grammar violation | compilation fails; all syntax errors are reported |
| Semantic | undefined variable, assignment to an undeclared name, duplicate declaration, unknown function, wrong argument count for a built-in | compilation fails (both runtimes run the same analyzer) |
| Runtime | type errors, division by zero, unknown host call, stack overflow, budget exceeded | unwinds to the nearest `try`; uncaught, the program stops with a message and source line |

`try { A } catch (e) { B }`: if a runtime error occurs in `A`, including inside any function called from `A`, the calls are unwound and execution continues in `B` with `e` bound to the error. Errors that occur before execution (lexical, syntax, semantic) cannot be caught, and neither can running out of the step or time budget.

**The caught value** is an object (fixed in D7):

| Key | Value |
| --- | --- |
| `kind` | `"runtime"` (the only catchable kind in v0) |
| `line` | source line of the failing operation, or `nil` when unknown (bytecode compiled without a line map, or ⚠ **D18**) |
| `message` | human-readable description. The text is **not** part of the language yet and differs between runtimes (`"Division by zero."` vs `"division by zero"`); don't branch on it. |

```
try { var x = 1 / 0; } catch (e) { print(objGet(e, "kind") + " at line " + objGet(e, "line")); }
```

`return` inside `try` returns from the function normally; it is not caught, and it leaves no handler behind. (Fixed in D19: `interp` caught `return` as an error, and the `vm` kept the handler of a function that returned from inside `try` and did not unwind calls made inside `try`.)

**Limits.** Every execution is bounded by default (fixed in D10; `while (true) {}` used to hang `vmrun` and `runSource`):

| Limit | Default | When exceeded | Configure |
| --- | --- | --- | --- |
| Call depth | 256 nested calls | runtime error, **catchable** | `VMConfig.MaxCallDepth`; `limits.maxCallDepth` |
| Stack depth (`vm`) | 1024 values | runtime error, catchable | `VMConfig.MaxStackDepth`; `vmrun -max-stack` |
| Steps | 10,000,000 | stops the program: `step budget exceeded`, **not catchable** | `VMConfig.MaxSteps`; `vmrun -max-steps`; `limits.maxSteps` |
| Wall time | 10 s | stops the program: `time budget exceeded`, **not catchable** | `VMConfig.MaxDuration`; `vmrun -timeout`; `limits.timeoutMs` |

A `vm` step is one bytecode instruction; an `interp` step is one statement, loop iteration or call, so the two counts are only roughly comparable. A budget applies to one run: `Run`/`interpret`, or one handler call. Hosts that run untrusted code set tighter budgets per call: the PulsarOS runtime manager uses 500,000 steps / 2 s to initialise a script and 250,000 steps / 1.5 s per RPC handler. Lifting a limit takes an explicit opt-out (`-max-steps 0`, `-timeout 0`, a negative `VMConfig` value, or `0`/`Infinity` in `limits`).

## 8. Built-in functions and host calls

Every function a script can call without declaring it is listed in **`hostapi.json`**, the registry shared by the compiler, the analyzer, the interpreter and the Go VM (decision A3; fixed D5, where each runtime kept its own list). An entry gives the name, the parameters with their types, the return type and, for host calls, the capability it will require (decision A4, not enforced yet).

- **Core** functions are pure and implemented inside every runtime, so they behave the same on every host.
- **Host** functions are supplied by the embedding host (the PulsarOS API's script manager, `host.ts` bridges, or `vmrun -sandbox-root` for `fsRead`/`fsWrite`/`fsList`/`fsExists`). A host that does not provide one raises a runtime error when it is called; `vmrun` alone returns `nil`.

Host calls are encapsulated in three layers:

1. **Compile time:** the analyzer and the compiler resolve each call. Unknown names and wrong argument counts are compile errors (§4.6).
2. **Load time:** the VM verifies a module before running it: every opcode is known, and every `HOST_CALL` names a registry entry with a valid argument count. Hand-written or stale bytecode that calls anything else is rejected with `invalid module: unknown host call …`.
3. **Call time:** argument types are checked against the registry. Core calls run inside the VM; only host entries reach the host's `HostCall` callback.

To add a built-in: add the entry to `hostapi.json`, implement it in `Interpreter.ts` (core or host) and, for core, in `pulsarscriptvm/builtins.go`, copy `hostapi.json` into pulsaros-api, add conformance cases, and run `bun run gen:hostapi` to refresh the table below. Tests on both sides fail if an entry has no implementation or an implementation has no entry.

Notes on the core functions:
- String indices and lengths (`len`, `indexOf`, `substr`) count Unicode code points.
- `round` rounds halves up (toward +Infinity) as JavaScript does, so `round(-2.5)` is `-2`.
- `parseInt` and `parseFloat` parse the **whole** string: `parseInt("19", 8)` and `parseInt("12px", 10)` are `nil`.
- `randomInt(a, b)` includes both bounds. After `randomSeed(n)` the sequence repeats on the same runtime, but the two runtimes use different generators.
- `toUpper`/`toLower` use simple case mapping; characters whose case changes length (such as `ß`) may differ between runtimes.
- `loadModule` was removed from the registry because no host implemented it (D8). Modules come back as registry entries in Phase 3.

<!-- hostapi:begin (generated by scripts/gen-hostapi-docs.ts; do not edit) -->

**Core** (implemented by every runtime; no host needed):

| Function | Parameters | Returns | Behaviour |
| --- | --- | --- | --- |
| `typeOf(value)` | value: any | string | Type name: nil, number, string, boolean, array or object. |
| `string(value)` | value: any | string | Printed form of a value (§3.2). |
| `number(value)` | value: any | number\|nil | Numbers as-is; true/false to 1/0; a decimal-literal string to its number; anything else to nil. |
| `concat(…parts)` | parts: any | string | Joins the printed forms of all arguments. |
| `len(value)` | value: string \| array | number | Length of a string in Unicode code points, or of an array. |
| `abs(n)` | n: number | number | Absolute value. |
| `floor(n)` | n: number | number | Largest integer not greater than n. |
| `ceil(n)` | n: number | number | Smallest integer not less than n. |
| `round(n)` | n: number | number | Nearest integer; halves round up (toward +Infinity), as in JavaScript. |
| `sqrt(n)` | n: number | number | Square root; NaN for negative n. |
| `pow(base, exponent)` | base: number, exponent: number | number | base raised to exponent. |
| `min(a, b)` | a: number, b: number | number | Smaller of a and b. |
| `max(a, b)` | a: number, b: number | number | Larger of a and b. |
| `clamp(n, lo, hi)` | n: number, lo: number, hi: number | number | min(max(n, lo), hi). |
| `isInteger(value)` | value: any | boolean | True for a number with no fractional part. |
| `isFinite(value)` | value: any | boolean | True for a number that is not NaN or ±Infinity. |
| `toUpper(s)` | s: string | string | Upper case (Unicode simple case mapping). |
| `toLower(s)` | s: string | string | Lower case (Unicode simple case mapping). |
| `trim(s)` | s: string | string | Removes leading and trailing whitespace. |
| `indexOf(s, sub)` | s: string, sub: string | number | Code-point index of the first occurrence of sub, or -1. |
| `substr(s, start, length)` | s: string, start: number, length: number | string | Up to length code points from start (both truncated toward zero; negative values are errors). |
| `parseInt(s, base)` | s: string \| number, base: number | number\|nil | Whole string as an integer in base 2-36 (optional sign, surrounding whitespace); nil if any character is not a digit of the base. |
| `parseFloat(s)` | s: string \| number | number\|nil | Whole string as a decimal number without exponent; nil otherwise. |
| `toNumberOr(value, fallback)` | value: any, fallback: any | any | number(value), or fallback when that is nil. |
| `clock()` | — | number | Milliseconds since the Unix epoch. |
| `random()` | — | number | Pseudo-random number in [0, 1). |
| `randomInt(a, b)` | a: number, b: number | number | Pseudo-random integer in [min(a, b), max(a, b)], bounds truncated toward zero. |
| `randomSeed(seed)` | seed: number | nil | Seeds random and randomInt so a run is repeatable on the same runtime. |
| `arrayLen(a)` | a: array | number | Number of elements. |
| `arrayPush(a, …values)` | a: array, values: any | array | New array with values appended. |
| `arrayPop(a)` | a: array | any | Last element, or nil when empty. Does not change a. |
| `arraySlice(a, start, end)` | a: array, start: number, end: number | array | Elements from start up to end (exclusive); indices truncated and clamped; start > end gives []. |
| `arrayConcat(a, …rest)` | a: array, rest: array | array | New array joining all arguments. |
| `arrayIndexOf(a, value)` | a: array, value: any | number | Index of the first element == value, or -1. |
| `objKeys(o)` | o: object | array | Keys in sorted order. |
| `objValues(o)` | o: object | array | Values in sorted key order. |
| `objHas(o, key)` | o: object, key: any | boolean | Whether string(key) is a key of o. |
| `objGet(o, key)` | o: object, key: any | any | Value at string(key), or nil. |
| `objSet(o, key, value)` | o: object, key: any, value: any | object | New object with string(key) set to value. |
| `registerHandler(name, functionName)` | name: string, functionName: string | nil | Exposes a top-level function to the host under name. |

**Host** (supplied by the embedding host; `vmrun` alone returns `nil`):

| Function | Parameters | Returns | Capability | Behaviour |
| --- | --- | --- | --- | --- |
| `kvGet(key)` | key: string | any | `kv` | Value stored under key, or nil. |
| `kvSet(key, value)` | key: string, value: any | any | `kv` | Stores value under key. |
| `kvDelete(key)` | key: string | any | `kv` | Removes key. |
| `fsRead(path)` | path: string | string\|nil | `fs.read` | File contents, or nil. |
| `fsList(path)` | path: string | array | `fs.read` | Directory entries. |
| `fsStat(path)` | path: string | object\|nil | `fs.read` | Entry metadata, or nil. |
| `fsExists(path)` | path: string | boolean | `fs.read` | Whether path exists. |
| `fsWrite(path, content)` | path: string, content: any | boolean | `fs.write` | Writes string(content) to path. |
| `fsDelete(path)` | path: string | boolean | `fs.write` | Deletes path. |
| `emitEvent(payload?)` | payload: any | any | `events` | Sends an event to the host. |
| `pollEvent()` | — | any | `events` | Next queued event, or nil. |
| `ipcSetContext(deviceId, processId)` | deviceId: string, processId: string | nil | `ipc` | Sets the device and process used by ipcSend. |
| `ipcSend(channel, op, payload)` | channel: string, op: string, payload: any | any | `ipc` | Sends a PulsarOS IPC message; subject to the app's allowed channels and operations. |

<!-- hostapi:end -->

## 9. Programs, handlers and the host

- A program runs top to bottom. On the `vm`, top-level `function` declarations form the module's function table, and any of them can be invoked by the host as a **handler** (RPC or service mode).
- An app declares its handlers in `AppManifest.json` (`script.bundle`, `script.exports`, `script.services`). The host checks that each declared handler exists.
- Host calls run with the app's permissions. IPC sends are checked against the app's allowed channels and operations and are rate-limited.

## 10. Bytecode format (v0)

Produced by `compile.ts`, consumed by the Go VM. JSON:

```json
{ "constants": [ … ], "code": [ … ], "functions": [ { "name", "address", "arity", "locals" } ], "lineMap": [ … ] }
```

- `code` is a flat array of opcode numbers, each followed by its operands. The opcode numbers are fixed by `Bytecode.ts`, mirrored in Go and pinned by a snapshot test; changing a number is a breaking format change.
- Operand counts: 1 for `CONST`, `DEFINE_GLOBAL`, `GET_GLOBAL`, `SET_GLOBAL`, `GET_LOCAL`, `SET_LOCAL`, `JUMP`, `JUMP_IF_FALSE`, `ENTER_BLOCK`, `EXIT_BLOCK`, `TRY_PUSH`, `NEW_ARRAY`, `NEW_OBJECT`; **2** for `CALL` (address, argument count) and `HOST_CALL` (name constant, argument count); 0 for the rest.

- Opcode names and operand counts live in one table in the VM (`OpcodeName`), used by the loader's verifier, `vmrun -disasm` and step mode. (Fixed in D9: the disassembler used to decode `CALL` with one operand.)
- `LoadModule` verifies the code before it runs (§8, load time).

- Top-level variables use `DEFINE_GLOBAL` / `GET_GLOBAL` / `SET_GLOBAL`; all other variables use local slots.

- `lineMap[i]` is the source line for `code[i]`, present when compiled with `-s`.

> ⚠ **D18**: the compiler only updates its current line at `var` statements, and jump placeholders add no `lineMap` entries, so line numbers in `vm` runtime errors are unreliable.
- There is no version field yet. Phase 1 adds a header `{format, version, compiler, sourceHash}`, and the loader will reject unknown versions.
- `YIELD`, `SLEEP`, `EMIT_EVENT` and `POLL_EVENT` exist in the VM but are never emitted by the compiler in v0.

## 11. Conformance

- `bun run conformance` runs every case on `interp`, and on the `vm` when `PULSARSCRIPT_VMRUN` points at a `vmrun` binary (`--require-vm` makes that mandatory). Cases are compiled with a line map (`-s`).
- A case is `<name>.poo` plus `<name>.expected`: one line per printed value, then an optional `!error` or `!error: <kind>` line (`parse`, `semantic`, `runtime`, `compile`).
- Known defects are marked in the case with `// @xfail <runtimes> <defect> <note>`. A marked case that starts passing fails the run until the marker is removed, so fixes are never silent.

## 12. Defect register

| ID | Summary | Runtimes | Status |
| --- | --- | --- | --- |
| D1 | Top-level variables compiled as locals; functions could not see globals | vm (interp: globals declared later) | **Fixed** |
| D2 | Calls to functions declared later failed | both | **Fixed** |
| D3 | Unknown names not caught at compile time | vm | **Fixed** (v0.3): calls resolve against `hostapi.json`; the VM also rejects unknown host calls at load |
| D4 | Array and object literals unsupported | interp | **Fixed** (v0.2) |
| D5 | Built-in sets differ; whitelisted VM built-ins return `nil`; the analyzer rejects interp natives | both | **Fixed** (v0.3): one registry; every core entry implemented on both runtimes |
| D6 | `+` with strings and implicit coercion differ | both | **Fixed** (v0.2): `+` concatenates with a string; `interp` strict by default |
| D7 | Caught error value unspecified | both | **Fixed** (v0.2): `{kind, line, message}` |
| D8 | `loadModule` whitelisted but does nothing | vm | **Closed** (v0.3): removed from the registry; modules are Phase 3 |
| D9 | Disassembler mis-decodes `CALL` | vmrun | **Fixed** |
| D10 | No default step/time budget in `vmrun` and `runSource` | both | **Fixed** (v0.3): default budgets everywhere; budget errors are not catchable |
| D11 | PulsarOS frontend script calls cannot reach the API | integration | Open: Phase 4 |
| D12 | App manifest `script` shape differs between frontend and API | integration | Open: Phase 4 |
| D13 | Syntax errors were swallowed; statements silently dropped | both | **Fixed** |
| D14 | Number formatting (`-0`, exponent form) | vm | **Fixed** |
| D15 | `arrayPush`/`arrayPop` do not mutate the variable's array | vm | **Decided** (v0.2): value semantics is the rule; the `vm` already complied |
| D16 | `&&`/`\|\|`: no short-circuit (interp), stack underflow (vm) | both | **Fixed** |
| D17 | Arrays and objects print as `<?>` | vm | **Fixed** (v0.2) |
| D18 | Line map only tracks `var` statements; runtime error lines unreliable | vm | Open: Phase 1 |
| D19 | `return` inside `try` caught as an error (interp); stale handler after `return` inside `try`, and no frame unwinding for errors in nested calls (vm) | both | **Fixed** |

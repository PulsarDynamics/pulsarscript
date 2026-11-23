# PulsarScript Language Specification — v1.0

**Status:** v1.0 (extended through runtime release v1.2, November 2026) specifies the complete PulsarScript language and bytecode runtime. Building on v0.1–v0.5 (D1–D19 resolved), v1.0–v1.2 adds string escape sequences (§2.4), template literals (§2.4), closures with upvalues and function expressions (§3, §6), copy-on-write collection updates preserving D15 value semantics (§3.3), lexicographic code-point string ordering (§4.3), lifted nested index assignment targets (§4.5), pragmatic syntax (`/* ... */`, ternary `?:`, hex `0x...` and scientific `1e3` literals with unified `parseFloat`/`number()`), static unreachable-code/duplicate/arity checks with column numbers and caught error `stack` traces (§7), the full standard library (§8), events/`sleep`/`yield` + async host suspension, build-time `import`/`export` modules (§5, §6), memory limits (§7), Bytecode v3 with backward compatibility for v0–v2 (§10), and host-call deprecation/compatibility policy (§8, §10).

**Authority:** the conformance suite in `tests/conformance/` is the executable form of this document (285 cases passing on both runtimes). A rule without a conformance case is not yet pinned. Every language change must update this file and add or adjust cases in the same pull request.

**Runtimes covered:**

| Name | Path | Role |
| --- | --- | --- |
| `vm` | `compile.ts` → JSON bytecode → Go VM (`vm/`, CLI `vm/cmd/vmrun`; imported by pulsaros-api as a Go module) | Production runtime. Scripts in PulsarOS apps run here. |
| `interp` | `Lexer` → `Parser` → `SemanticAnalyzer` → `Interpreter` (TypeScript; `repl.ts`, `host.ts`) | Development runtime (REPL, embedding). Its future is decision A1 in the development plan. |

---

## 1. Source text

- Source files use the extension **`.puls`**, are UTF-8, and are read as a whole. (`.poo`, the old extension, is still compiled with a deprecation warning.)
- A packaged PulsarOS app, which carries its compiled scripts, is a **`.pulsar`** file (§9).
- **Whitespace:** space, tab, carriage return and newline separate tokens. Newlines also advance the line counter used in error messages.
- **Comments:** `//` to the end of the line, and non-nesting block comments `/* ... */` (unterminated block comment is a lexical error).
- **Statements end with `;`**, except block statements, `if`, `while`, `for`, `function` and `try` declarations.

## 2. Lexical grammar

### 2.1 Keywords

`var` `const` `function` `return` `if` `else` `while` `for` `break` `continue` `print` `try` `catch` `true` `false` `nil` `import` `export`

`of` (`for (var x of ...)`), `from`, and `as` (`import`/`export`) are contextual identifiers and remain valid identifiers elsewhere.

### 2.2 Identifiers

A letter or `_`, followed by letters, digits or `_`. Identifiers are case-sensitive. A keyword cannot be an identifier.

### 2.3 Number literals

Decimal digits (`42`, `3.25`, `0.5`, `.5`), optional exponent (`1e3`, `1.5e-2`, `1E+4`), and hexadecimal integer literals (`0xff`, `0x10AB`). There are no octal/binary literals or digit separators. A trailing dot (`1.`) is not part of a number: it lexes as `1` followed by `.`. Numbers are IEEE-754 double precision. `number(s)` and `parseFloat(s)` accept the same decimal + exponent grammar.

### 2.4 String literals and template literals

Double-quoted strings `"hello"` and backtick template literals `` `Hi ${name}` `` may span lines.
- Supported escapes in strings: `\n`, `\t`, `\r`, `\\`, `\"`, and `\u{X...}` (1–6 hex digits for Unicode scalar value `0..0x10FFFF`, excluding surrogates `0xD800..0xDFFF`). Any other escape sequence (such as `\q`, `\$`, or `\` `) is a lexical error.
- Template literals also support `` \` `` and `\$` (literal `$` not followed by `{` needs no escape), arbitrary interpolated expressions `${expr}` including nested templates and object literals, and evaluate parts strictly left-to-right as string concatenation. Tagged templates are not supported.
- An unterminated string, template literal, or Unicode escape is a lexical error.

### 2.5 Operators and punctuation

`+ - * / % ! = += -= *= /= %= == != < <= > >= && || ? : ( ) { } [ ] . , ;`

`? :` is right-associative ternary conditional evaluation (evaluating only the chosen branch). There is no `++`/`--`, `switch`, or `do…while`. Any other character is a lexical error ("Unexpected character").

## 3. Values and types

| Type | Literal | `typeOf` | Notes |
| --- | --- | --- | --- |
| number | `42`, `3.25` | `"number"` | IEEE-754 double |
| string | `"text"` | `"string"` | immutable |
| boolean | `true`, `false` | `"boolean"` | |
| nil | `nil` | `"nil"` | the absence of a value; uninitialised variables and functions without a return value produce `nil` |
| array | `[1, "a", true]` | `"array"` | ordered list of any values |
| object | `{name: "x", n: 1}` | `"object"` | string keys to any values; keys in a literal are identifiers, a repeated key keeps the last value |
| function | `function(x) { ... }`, `function name(...)` | `"function"` | a declared function or closure expression capturing lexical variables; prints as `<fn name>` or `<fn anonymous>` |

**Functions and closures:** declared functions and anonymous/named `function(params) { body }` expressions are first-class values that can be stored, passed, returned, and compared (`==` compares closure/function identity). Nested functions and function expressions capture enclosing local variables as shared Lua-style upvalues (closed cleanly when blocks, loops, functions, or `try` blocks exit or unwind). Named function expressions bind their name inside their own body only. `registerHandler(name, fnOrName)` accepts either a top-level function name or a function/closure value. Built-ins and host calls are not values.

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

Arrays and objects have **value semantics** (D15): logically, no write mutates an existing array or object value seen through another variable. Internally, the Go VM backs arrays and objects with Conchon–Filliâtre copy-on-write (CoW) persistent handles so linear appends (`a[len(a)] = v`) and key updates (`o[k] = v`, `objDelete`) run in O(1) amortized time and memory on unshared paths without copying the whole container. (`o.list[0] = 1` still leaves any prior snapshot of `o` unchanged.)

`arrayPop(a)` returns the last element (or `nil`) and does not shorten `a`; use `arraySlice(a, 0, arrayLen(a) - 1)` for the rest.

## 4. Expressions

### 4.1 Precedence (lowest to highest)

| Level | Operators | Associativity |
| --- | --- | --- |
| Assignment | `=` `+=` `-=` `*=` `/=` `%=` | right |
| Ternary | `? :` | right |
| Logical OR | `\|\|` | left |
| Logical AND | `&&` | left |
| Equality | `==` `!=` | left |
| Comparison | `<` `<=` `>` `>=` | left |
| Additive | `+` `-` | left |
| Multiplicative | `*` `/` `%` | left |
| Unary | `!` `-` | right |
| Call, index, member | `f(args)` `x[k]` `o.key` | left |
| Primary | literals, templates, `function(...) { ... }`, identifiers, `( expr )`, array and object literals | |

### 4.2 Arithmetic

`+ - * /` on two numbers have IEEE-754 semantics, **except that division by zero is a runtime error** in both runtimes. `%` is the remainder with the sign of the dividend (`-7 % 3` is `-1`, `7.5 % 2` is `1.5`); `%` by zero is a runtime error. Unary `-` negates a number.

**`+` concatenates when either operand is a string**, converting the other operand to its printed form (§3.2): `"a" + 1` → `"a1"`, `"v: " + nil` → `"v: nil"`, `"xs: " + [1]` → `"xs: [1]"`. `+` is left-associative, so `1 + 2 + "x"` is `"3x"` and `"x" + 1 + 2` is `"x12"`. (Fixed in D6.)

Any other arithmetic on a non-number, such as `true + 1` or `-"a"`, is a runtime error, and so is passing the wrong type to a built-in (`abs("x")`). `interp` keeps a `strictTypes: false` option for old embedders that coerces built-in arguments instead; it is off by default and outside the language.

### 4.3 Comparison and equality

`< <= > >=` compare two numbers OR two strings (lexicographically by Unicode code point, so astral characters like `"\u{1F600}"` sort after BMP `"\u{FFFF}"` identically in UTF-8 and JS code-point iteration). Comparing mixed types (such as `"1" < 2`) is a catchable runtime error. `==` and `!=` compare type and value, with **no type coercion**: `1 == "1"` is `false`, and `nil == false` is `false`. **Arrays and objects compare by contents**, recursively: `[1, [2]] == [1, [2]]` and `{a: 1, b: 2} == {b: 2, a: 1}` are `true`. `arrayIndexOf` and `arrayIncludes` use the same equality.

### 4.4 Logical operators

`!x` is `true` when `x` is falsy. `a && b` and `a || b` always evaluate to `true` or `false` (never to an operand) and **short-circuit**: `b` is not evaluated when `a` decides the result. `&&` binds tighter than `||`. (Fixed in D16.)

### 4.5 Assignment

`name = expr` assigns to an existing variable and evaluates to the assigned value, so `a = b = 5` sets both. Assigning to an undeclared name, a `const` (§6) or a function declaration is a compile-time error. (Fixed on the `vm` in D3; it used to create a global silently.)

**Compound assignment** `x op= e` (for `+ - * / %`) is `x = x op e`.

**Element and property assignment** `a[i] = v`, `o.key = v`, `a[i][j] = v`, `o.list[0] += 1` (v0.5):
- Arrays and objects are values (§3.3), so assignment builds a copy with the new element and stores it back into the **variable at the root** of the target. Any other variable that held the old array or object is unchanged.
- The root must be a variable: `f()[0] = 1` is a compile-time error.
- It is a **statement** of its own (an expression statement or a `for` increment), not an expression: `x = (a[0] = 1)` is a compile-time error.
- Any expression may serve as an index in a nested write (`o.items[len(o.items)] = i` or `o[getKey()][idx + 1] = v`); keys are evaluated once from outer to inner, avoiding duplicate side effects. Compound element assignment (`a[i] += v`) evaluates its indices and updates the element in place.
- Writing at index `len(a)` appends; any other index outside `0..len(a)-1` is a runtime error. Strings cannot be assigned into.

### 4.6 Calls

`name(arg, …)` calls a user function declared with `function` or a function in the registry (§8). At most 255 arguments. A user function with the same name as a built-in takes precedence. Any other expression that produces a function value can be called too: a variable or parameter holding one (`f(x)`), an element (`fns[0](x)`) or a property (`handlers.save(x)`); a local or global variable shadows a function or built-in of the same name.

**Calls are resolved at compile time.** A name that is neither a user function nor in the registry is a compile-time error (`Unknown function 'x'.`), and so is a wrong argument count for a built-in. Argument *types* are checked when the call runs. (Fixed in D3: unknown names used to compile as host calls that failed at runtime, where `try`/`catch` could swallow them.)

**Top-level functions are hoisted:** a call resolves to any function declared at the top level of the file, including one declared later and including calls made before the declaration. Functions declared inside a block are callable after their declaration within that block. (Fixed in D2.)

### 4.7 Indexing and member access

`x[k]` reads an element (v0.5):

| `x` | `k` | Result |
| --- | --- | --- |
| array | integer number | the element; outside `0..len(x)-1` is a runtime error |
| string | integer number | the character (Unicode code point) at that position, as a string |
| object | string | the property's value, or `nil` when the key is missing |

`o.key` is `o["key"]` for objects; on any other value it is a runtime error. A non-integer index, a non-string object key, or indexing `nil`, a number or a boolean is a runtime error. All of these are catchable.


## 5. Statements

| Statement | Form | Notes |
| --- | --- | --- |
| Expression | `expr;` | value discarded |
| Print | `print(expr);` | writes one line (§3.2) |
| Variable | `var name;` / `var name = expr;` | without an initializer the value is `nil` |
| Block | `{ … }` | opens a scope |
| If | `if (cond) stmt` / `if (cond) stmt else stmt` | `else if` is an `if` in the else branch |
| While | `while (cond) stmt` | |
| Constant | `const name = expr;` | must be initialised; cannot be reassigned, nor its elements |
| For | `for (init; cond; incr) stmt` | each part optional; `init` may be a `var` scoped to the loop |
| For…of | `for (var x of e) stmt` / `for (const x of e) stmt` | `e` is evaluated once: an array yields its elements, an object its keys in sorted order, a string its characters; anything else is a runtime error |
| Break | `break;` | leaves the innermost loop |
| Continue | `continue;` | goes to the next iteration (a `for` loop runs its increment first) |
| Function | `function name(p1, p2) { … }` | top level or nested in blocks (capturing enclosing locals) |
| Return | `return;` / `return expr;` | `return;` yields `nil` |
| Try/catch | `try { … } catch (e) { … }` | `(e)` may be omitted |
| Import | `import { a, b as c } from "./util.puls";` | top-level only; resolved and linked at build time (no cycles, immutable local bindings) |
| Export | `export function/var/const ...` / `export { a, b as c };` | top-level only |

There is no `switch`, `do…while` or `let`. `break` and `continue` must be inside a loop of the same function (a compile-time error otherwise); they leave any blocks and `try` blocks in between. Unreachable code after terminating statements and duplicate top-level/local/parameter declarations are compile-time errors.

A syntax error stops compilation. The parser recovers after each error so that **every** syntax error in the file is reported in one pass, each with its line. (Fixed in D13: errors used to be swallowed and the statement silently dropped.)

## 6. Scope and variables

- **Lexical block scoping.** Every block, function body and `for` loop opens a scope. An inner declaration shadows outer ones until the scope ends.
- Declaring the same name twice in one scope is an error.
- **Top-level variables are globals**: a `var` outside every function, block and `try` block. Function bodies may read and assign globals declared anywhere in the file; at the top level a global must be declared before it is used. (Fixed in D1: the `vm` used to compile them as locals that functions could not see.)
- A `var` inside a block, function body, `for` initializer or `try` block is local.
- `const` declares a variable the same way (global at the top level, local elsewhere) that cannot be assigned again, directly or through an element or property.

- Function parameters and `var`s inside a function are local to each call.
- **Closures:** functions declared inside blocks or function expressions capture variables from enclosing blocks, loops (`for...of` closes per-iteration bindings cleanly), or functions into Lua-style upvalues shared across closures over the same slot. Values still follow D15 value semantics: reassigning the outer variable updates what capturing closures see, while updating an element of a captured collection replaces that variable's copy without mutating other snapshots.
- **Modules:** build-time `import` and `export` are linked into one single-chunk bundle by `Linker` / `compile.ts`. Dependencies execute once in topological post-order before the entry script. Import cycles, missing modules/exports, and assigning to an imported binding are compile-time errors. Multi-file line/file maps (`sources`/`fileMap`) preserve original file names and line numbers in `e.stack`.

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
| `kind` | `"runtime"` (the only catchable kind) |
| `line` | source line of the failing operation (for an operator, the operator's line; for a call, the function name's line), or `nil` when the bytecode has no line map. (Fixed in D18.) |
| `message` | human-readable description. The text is **not** part of the language and differs between runtimes (`"Division by zero."` vs `"division by zero"`); don't branch on it. |
| `stack` | array of call frame strings ordered innermost-first (e.g. `["inner (util.puls:2)", "outer (app.puls:5)", "<script> (app.puls:9)"]`, using `line N` in single-file programs). |

```
try { var x = 1 / 0; } catch (e) { print(objGet(e, "kind") + " at line " + objGet(e, "line") + ", frames: " + len(e.stack)); }
```

`return` inside `try` returns from the function normally; it is not caught, and it leaves no handler behind. (Fixed in D19.)

**Limits.** Every execution is bounded by default (D10, LANG-01, LANG-11):

| Limit | Default (`vmrun`/REPL) | RPC (`RPCVMConfig`) | Service (`ServiceVMConfig`) | When exceeded | Configure |
| --- | --- | --- | --- | --- | --- |
| Call depth | 256 nested calls | 256 | 256 | runtime error, **catchable** | `VMConfig.MaxCallDepth`; `limits.maxCallDepth` |
| Stack depth (`vm`) | 1024 values | 1024 | 1024 | runtime error, catchable | `VMConfig.MaxStackDepth`; `vmrun -max-stack` |
| Steps | 10,000,000 | 10,000,000 (`pulsaros-api`: 250k) | 10,000,000 | `step budget exceeded`, **not catchable** | `VMConfig.MaxSteps`; `limits.maxSteps` |
| Wall time | 10 s | 10 s (`pulsaros-api`: 1.5 s) | 10 s | `time budget exceeded`, **not catchable** | `VMConfig.MaxDuration`; `limits.timeoutMs` |
| Single string bytes | 16 MiB | 1 MiB | 4 MiB | `memory limit exceeded`, **not catchable** | `VMConfig.MaxStringBytes`; `-max-string` |
| Single collection len | 1,000,000 | 100,000 | 100,000 | `memory limit exceeded`, **not catchable** | `VMConfig.MaxCollectionLen`; `-max-elements` |
| Live heap objects | 1,000,000 | 200,000 | 500,000 | `memory limit exceeded`, **not catchable** | `VMConfig.MaxHeapCount`; `-max-heap` |
| Estimated live memory | 256 MiB | 16 MiB | 64 MiB | `memory limit exceeded`, **not catchable** | `VMConfig.MaxMemoryBytes`; `-max-memory` |

Async host suspensions (`ErrSuspended`) and `sleep`/`yield` are **not catchable** by `try/catch`; however, errors delivered on async resume ARE caught by an enclosing `try/catch`, and step/time/memory budgets carry across suspensions. Callback functions passed to `arrayMap`/`arrayFilter`/`arrayReduce`/`arrayFind`/`arraySort` share the caller's step/time/memory budgets.

## 8. Built-in functions and host calls

Every function a script can call without declaring it is listed in **`vm/hostapi.json`**, the one registry read by the compiler, the analyzer, the interpreter and the Go VM (decision A3; fixed D5, where each runtime kept its own list). An entry gives the name, the parameters with their types, the return type and, for host calls, the capability it will require (decision A4, not enforced yet).

- **Core** functions are pure and implemented inside every runtime, so they behave the same on every host.
- **Host** functions are supplied by the embedding host (the PulsarOS API's script manager, `host.ts` bridges, or `vmrun -sandbox-root` for `fsRead`/`fsWrite`/`fsList`/`fsExists`). A host that does not provide one raises a runtime error when it is called; `vmrun` alone returns `nil`.

Host calls are encapsulated in three layers:

1. **Compile time:** the analyzer and the compiler resolve each call. Unknown names and wrong argument counts are compile errors (§4.6).
2. **Load time:** the VM verifies a module before running it: every opcode is known, and every `HOST_CALL` names a registry entry with a valid argument count. Hand-written or stale bytecode that calls anything else is rejected with `invalid module: unknown host call …`.
3. **Call time:** argument types are checked against the registry. Core calls run inside the VM; only host entries reach the host's `HostCall` callback.

To add a built-in: add the entry to `hostapi.json`, implement it in `Interpreter.ts` (core or host) and, for core, in `vm/builtins.go`, add conformance cases, and run `bun run gen:hostapi` to refresh the table below. Tests on both sides fail if an entry has no implementation or an implementation has no entry.

Notes on the core functions:
- String indices and lengths (`len`, `indexOf`, `lastIndexOf`, `substr`, `padStart`, `padEnd`, `charCodeAt`) count Unicode code points.
- `round` rounds halves up (toward +Infinity) as JavaScript does, so `round(-2.5)` is `-2`.
- `parseInt` and `parseFloat` parse the **whole** string: `parseInt("19", 8)` and `parseInt("12px", 10)` are `nil`.
- `randomInt(a, b)` includes both bounds. After `randomSeed(n)` the sequence repeats on the same runtime, but the two runtimes use different generators.
- `toUpper`/`toLower` use simple case mapping; characters whose case changes length (such as `ß`) may differ between runtimes.
- `loadModule` was removed from the registry (D8); static build-time `import`/`export` modules replace dynamic loading.
- Registry entries may carry `"deprecated": "<note>"` (LANG-15): `SemanticAnalyzer` records a compile warning for at least one minor release before removal.

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
| `sin(n)` | n: number | number | Sine of n in radians. |
| `cos(n)` | n: number | number | Cosine of n in radians. |
| `tan(n)` | n: number | number | Tangent of n in radians. |
| `atan2(y, x)` | y: number, x: number | number | Two-argument arctangent of y/x in radians. |
| `log(n)` | n: number | number | Natural logarithm of n. |
| `log10(n)` | n: number | number | Base-10 logarithm of n. |
| `exp(n)` | n: number | number | Euler's number e raised to the power n. |
| `mathPi()` | — | number | The ratio of a circle's circumference to its diameter (pi). |
| `mathE()` | — | number | Euler's number (e). |
| `toUpper(s)` | s: string | string | Upper case (Unicode simple case mapping). |
| `toLower(s)` | s: string | string | Lower case (Unicode simple case mapping). |
| `trim(s)` | s: string | string | Removes leading and trailing whitespace. |
| `indexOf(s, sub, start?)` | s: string, sub: string, start: number | number | Code-point index of the first occurrence of sub at or after start (default 0), or -1. |
| `lastIndexOf(s, sub, start?)` | s: string, sub: string, start: number | number | Code-point index of the last occurrence of sub at or before start (default end), or -1. |
| `split(s, sep)` | s: string, sep: string | array | Splits s by sep (or into code points when sep is empty). |
| `replace(s, target, replacement)` | s: string, target: string, replacement: string | string | Replaces all non-overlapping occurrences of target with replacement. |
| `startsWith(s, prefix)` | s: string, prefix: string | boolean | Whether s begins with prefix. |
| `endsWith(s, suffix)` | s: string, suffix: string | boolean | Whether s ends with suffix. |
| `repeat(s, count)` | s: string, count: number | string | Concatenates count copies of s (count truncated toward zero; non-negative). |
| `padStart(s, length, fill?)` | s: string, length: number, fill: string | string | Pads the start of s with fill (default space) up to length code points. |
| `padEnd(s, length, fill?)` | s: string, length: number, fill: string | string | Pads the end of s with fill (default space) up to length code points. |
| `charCodeAt(s, index)` | s: string, index: number | number\|nil | Unicode code point at code-point index, or nil if out of range. |
| `fromCharCode(code)` | code: number | string | Single-character string for Unicode scalar value code. |
| `substr(s, start, length)` | s: string, start: number, length: number | string | Up to length code points from start (both truncated toward zero; negative values are errors). |
| `parseInt(s, base)` | s: string \| number, base: number | number\|nil | Whole string as an integer in base 2-36 (optional sign, surrounding whitespace); nil if any character is not a digit of the base. |
| `parseFloat(s)` | s: string \| number | number\|nil | Whole string as a decimal number with optional exponent; nil otherwise. |
| `toNumberOr(value, fallback)` | value: any, fallback: any | any | number(value), or fallback when that is nil. |
| `clock()` | — | number | Milliseconds since the Unix epoch. |
| `dateFormat(ms, pattern?)` | ms: number, pattern: string | string | Formats epoch milliseconds in UTC (default YYYY-MM-DDTHH:mm:ss.SSSZ). |
| `dateParse(s)` | s: string | number\|nil | Parses an ISO-8601 UTC/offset date string into epoch milliseconds, or nil. |
| `random()` | — | number | Pseudo-random number in [0, 1). |
| `randomInt(a, b)` | a: number, b: number | number | Pseudo-random integer in [min(a, b), max(a, b)], bounds truncated toward zero. |
| `randomSeed(seed)` | seed: number | nil | Seeds random and randomInt so a run is repeatable on the same runtime. |
| `arrayLen(a)` | a: array | number | Number of elements. |
| `arrayPush(a, …values)` | a: array, values: any | array | New array with values appended. |
| `arrayPop(a)` | a: array | any | Last element, or nil when empty. Does not change a. |
| `arraySlice(a, start, end)` | a: array, start: number, end: number | array | Elements from start up to end (exclusive); indices truncated and clamped; start > end gives []. |
| `arrayConcat(a, …rest)` | a: array, rest: array | array | New array joining all arguments. |
| `arrayIndexOf(a, value)` | a: array, value: any | number | Index of the first element == value, or -1. |
| `arrayJoin(a, sep?)` | a: array, sep: string | string | Joins printed elements using sep (default ","). |
| `arrayIncludes(a, value)` | a: array, value: any | boolean | Whether any element == value. |
| `arrayMap(a, fn)` | a: array, fn: function | array | New array containing fn(el) for each element. |
| `arrayFilter(a, fn)` | a: array, fn: function | array | New array of elements for which fn(el) is truthy. |
| `arrayReduce(a, fn, initial)` | a: array, fn: function, initial: any | any | Reduces elements left-to-right starting at initial via fn(acc, el). |
| `arrayFind(a, fn)` | a: array, fn: function | any | First element for which fn(el) is truthy, or nil. |
| `arraySort(a, cmp?)` | a: array, cmp: function | array | New stably sorted array (numeric/code-point order by default, or cmp(a, b) returning negative/zero/positive). |
| `objKeys(o)` | o: object | array | Keys in sorted order. |
| `objValues(o)` | o: object | array | Values in sorted key order. |
| `objHas(o, key)` | o: object, key: any | boolean | Whether string(key) is a key of o. |
| `objGet(o, key)` | o: object, key: any | any | Value at string(key), or nil. |
| `objSet(o, key, value)` | o: object, key: any, value: any | object | New object with string(key) set to value. |
| `objDelete(o, key)` | o: object, key: any | object | New object without string(key). |
| `objEntries(o)` | o: object | array | Array of [key, value] pairs in sorted key order. |
| `objMerge(a, …rest)` | a: object, rest: object | object | New object merging keys left-to-right; later values overwrite earlier ones. |
| `jsonParse(s)` | s: string | any | Parses JSON text into PulsarScript values (null maps to nil; max depth 64). |
| `jsonStringify(value)` | value: any | string | Formats a value as JSON with sorted keys (max depth 64; rejects non-finite numbers and functions). |
| `registerHandler(name, handler)` | name: string, handler: string \| function | nil | Exposes a top-level function by name or function/closure value to the host under name. |
| `on(event, handler)` | event: string, handler: function | nil | Registers a function listener for named host/script events. |
| `emit(name, payload?)` | name: string, payload: any | nil | Emits an event {name, payload} to the host or event queue. |
| `sleep(ms)` | ms: number | nil | Suspends execution for at least ms milliseconds. |
| `yield()` | — | nil | Yields control back to the host scheduler. |

**Host** (supplied by the embedding host; `vmrun` alone returns `nil`):

| Function | Parameters | Returns | Capability | Behaviour |
| --- | --- | --- | --- | --- |
| `kvGet(key)` | key: string | any | `kv` | Value stored under key, or nil. |
| `kvSet(key, value)` | key: string, value: any | any | `kv` | Stores value under key. |
| `kvDelete(key)` | key: string | any | `kv` | Removes key. |
| `fsRead(path)` | path: string | string\|nil | `fs.read` | Contents of the file at path as text, or nil when it does not exist. |
| `fsList(path)` | path: string | array | `fs.read` | Entries of the folder at path: objects {name, dir, size, modified}. |
| `fsStat(path)` | path: string | object\|nil | `fs.read` | {name, dir, size, modified} for path, or nil when it does not exist. |
| `fsExists(path)` | path: string | boolean | `fs.read` | Whether path exists. |
| `fsWrite(path, content)` | path: string, content: any | boolean | `fs.write` | Writes string(content) to path, creating missing folders. |
| `fsDelete(path)` | path: string | boolean | `fs.write` | Deletes the file or folder (with its contents) at path. |
| `fsMkdir(path)` | path: string | boolean | `fs.write` | Creates the folder at path and any missing parents. |
| `fsRename(from, to)` | from: string, to: string | boolean | `fs.write` | Renames or moves a file or folder. |
| `fsCopy(from, to)` | from: string, to: string | boolean | `fs.write` | Copies a file or folder (recursively) to a new path. |
| `fsQuota()` | — | object | `fs.read` | {used, max} in bytes for the user's storage. |
| `fsReadBase64(path)` | path: string | string\|nil | `fs.read` | Contents of the file at path as Base64, for binary files; nil when it does not exist. |
| `fsWriteBase64(path, data)` | path: string, data: string | boolean | `fs.write` | Writes Base64-decoded data to path, for binary files. |
| `emitEvent(payload?)` | payload: any | any | `events` | Sends an event to the host. |
| `pollEvent()` | — | any | `events` | Next queued event, or nil. |
| `notifyWindow(payload)` | payload: any | nil | `window` | Sends payload to the app's open windows as an SDK script.event (progress, results of a service). |
| `ipcSetContext(deviceId, processId)` | deviceId: string, processId: string | nil | `ipc` | Sets the device and process used by ipcSend. |
| `ipcSend(channel, op, payload)` | channel: string, op: string, payload: any | any | `ipc` | Sends a PulsarOS IPC message; subject to the app's allowed channels and operations. |

<!-- hostapi:end -->

## 9. Programs, handlers and the host

- A program runs top to bottom. Its top-level code calls `registerHandler(name, functionName)` for each function the host may invoke; only registered handlers can be called.
- An app declares its script in `AppManifest.json` (fixed in D12; one shape for the PulsarOS frontend, `appbundle` and the API loader, schema in pulsaros-api `docs/app_manifest.schema.json`):

  ```json
  "permissions": { "scopes": ["fs.list"] },
  "script": {
    "bundle": "scripts/app.json",
    "source": "scripts/app.puls",
    "handlers": [ { "name": "analyze", "mode": "rpc" }, { "name": "watcher", "mode": "service" } ]
  }
  ```

  `appbundle` checks that the declared handlers and the registered ones match, and that the bundle was compiled from the current source (§10). The legacy `exports`/`services` forms are still read, with a warning.
- An app is distributed as a **`.pulsar` package**: a zip archive with `AppManifest.json` at its root and the app's files, including the compiled script bundle. `fruit build` and `appbundle package` write it; `.app`, the old package extension, is still read.
- **Calling a handler** (fixed in D11): the app sends the IPC envelope `{v: 1, deviceId, processId, channel: "ipc.call", op: "script.call", payload: {appId, handler, args}, nonce, ts}` to the API's `/api/ipc`; services use `script.service.start`, `stop` and `status`. A non-list `args` is the handler's one argument; a list is the argument list. Arguments and results convert between JSON and PulsarScript values in both directions, objects and arrays included. An app can always call its own handlers and no other app's.
- Handlers run with the app's identity and permissions. A script's `ipcSend(channel, op, payload)` reaches only the channels in the manifest's `permissions.scopes` (none without scopes), is rate-limited and raises a runtime error when refused or when the target fails. `ipcSetContext` cannot switch a server script to another device or process.

## 10. Bytecode format (version 3) & compatibility policy

Produced by `compile.ts`, consumed by the Go VM (`vm/`, a Go module in this repository; hosts import `github.com/PulsarDynamics/pulsarscript/vm` at a `vm/vX.Y.Z` tag). JSON:

```json
{
  "format": "pulsarscript-bytecode", "version": 3,
  "compiler": "pulsarscript 1.2.0", "sourceHash": "sha256:…",
  "constants": [ … ], "code": [ … ],
  "functions": [ { "name", "address", "arity", "locals", "upvalues"?, "selfSlot"? } ],
  "lineMap": [ … ], "sources"?: [ … ], "fileMap"?: [ … ]
}
```

**Header & Compatibility Policy** (decision A5, LANG-15): `format` identifies the file; `version` is the format version (`Bytecode.ts` `BYTECODE_VERSION`, Go `BytecodeVersion`); `compiler` names the compiler that wrote it; `sourceHash` is the SHA-256 of the UTF-8 source, so tools can tell a bundle that is stale against its `.puls` source. The VM guarantees backward compatibility for bytecode versions **N** and **N−1** (and currently loads versions **0 through 3**), rejecting any unsupported or future version with an error asking to recompile or upgrade. Version 0 has no header; version 2 adds `INDEX_GET`, `INDEX_SET`, `MOD`, `FUNC`, `CALL_VALUE`, and `ITER_ITEMS`; version 3 (SPEC v1.0) adds `CLOSURE`, `GET_UPVALUE`, `SET_UPVALUE`, `CLOSE_UPVALUE`, function `upvalues`/`selfSlot` metadata, and multi-file `sources`/`fileMap`.

- `code` is a flat array of opcode numbers (0–51), each followed by its operands. The opcode numbers are fixed by `Bytecode.ts`, mirrored in `vm/vm.go` and checked against each other by `vm/opcodes_test.go` and a snapshot test.
- Operand counts: 1 for `CONST`, `DEFINE_GLOBAL`, `GET_GLOBAL`, `SET_GLOBAL`, `GET_LOCAL`, `SET_LOCAL`, `JUMP`, `JUMP_IF_FALSE`, `ENTER_BLOCK`, `EXIT_BLOCK`, `TRY_PUSH`, `NEW_ARRAY`, `NEW_OBJECT`, `INDEX_GET`, `INDEX_SET`, `FUNC`, `CALL_VALUE`, `CLOSURE`, `GET_UPVALUE`, `SET_UPVALUE`, `CLOSE_UPVALUE`; **2** for `CALL` (address, argument count) and `HOST_CALL` (name constant, argument count); 0 for the rest.
- Direct calls to `yield()`, `sleep(ms)`, `emit(name, payload?)`, and `pollEvent()` emit `YIELD`, `SLEEP`, `EMIT_EVENT`, and `POLL_EVENT` directly.
- Top-level variables use `DEFINE_GLOBAL` / `GET_GLOBAL` / `SET_GLOBAL`; all other variables use local slots or upvalue cells.
- `lineMap[i]` and `fileMap[i]` map `code[i]` to its source line and `sources` index when compiled with `-s`.

## 11. Conformance

- `bun run conformance` runs every case on `interp` and on the `vm`. It builds `vm/cmd/vmrun` from the checkout when Go is installed; `PULSARSCRIPT_VMRUN` or `--vmrun` point at another binary, and `--require-vm` fails the run when no VM is available. Cases are compiled with a line map (`-s`).
- A case is `<name>.puls` plus `<name>.expected`: one line per printed value, then an optional `!error` or `!error: <kind>` line (`parse`, `semantic`, `runtime`, `compile`).
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
| D11 | PulsarOS frontend script calls cannot reach the API | integration | **Fixed** (v0.4): real envelope to the connected server; JSON values both ways; nested `ipcSend` without deadlock |
| D12 | App manifest `script` shape differs between frontend and API | integration | **Fixed** (v0.4): one `script.handlers` shape and schema; reference apps ship compiled bundles |
| D13 | Syntax errors were swallowed; statements silently dropped | both | **Fixed** |
| D14 | Number formatting (`-0`, exponent form) | vm | **Fixed** |
| D15 | `arrayPush`/`arrayPop` do not mutate the variable's array | vm | **Decided** (v0.2): value semantics is the rule; the `vm` already complied |
| D16 | `&&`/`\|\|`: no short-circuit (interp), stack underflow (vm) | both | **Fixed** |
| D17 | Arrays and objects print as `<?>` | vm | **Fixed** (v0.2) |
| D18 | Line map only tracks `var` statements; runtime error lines unreliable | vm | **Fixed** (v0.4) |
| D19 | `return` inside `try` caught as an error (interp); stale handler after `return` inside `try`, and no frame unwinding for errors in nested calls (vm) | both | **Fixed** |

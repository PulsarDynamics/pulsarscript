# PulsarScript Language Specification — v0

**Status:** v0 records the language **as it behaves today** (November 2026). Where today's behaviour is wrong or the two runtimes disagree, the rule says what the language *should* do and points to a defect (⚠ **Dn**). The [defect register](#12-defect-register) at the end lists all of them.

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

> ⚠ **D13**: `1e3` currently lexes as `1` followed by the identifier `e3`. The parser then swallows the resulting syntax error and **drops the statement**. It must be a syntax error.

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
| array | `[1, "a", true]` | `"array"` | `vm` only (⚠ **D4** for `interp`) |
| object | `{name: "x", n: 1}` | `"object"` | `vm` only (⚠ **D4**); keys are identifiers, values are any expression |

There are no function values in v0: functions cannot be stored in variables, passed as arguments or returned (planned for Phase 2).

### 3.1 Truthiness

`nil` and `false` are falsy. **Every other value is truthy, including `0` and `""`.**

### 3.2 Printing values

`print(expr)` writes one line. Numbers print in the shortest form that round-trips (as in JavaScript): `5`, `3.5`, `0.30000000000000004`, `3628800`. Booleans print as `true`/`false`, `nil` as `nil`, strings without quotes.

> ⚠ **D14**: the `vm` prints `-0` for negative zero and uses exponent form for large values (`3.6288e+06`). It must match the rule above.
> ⚠ **D17**: the `vm` prints arrays and objects as `<?>`. The required format is not specified yet (Phase 2).

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

`+` with a string operand:

> ⚠ **D6** (decision pending): `interp` concatenates (`"a" + 1` → `"a1"`); `vm` raises a runtime error for any `+` involving a string, **including `"foo" + "bar"`**. Recommended rule: `+` concatenates when either operand is a string, converting the other with `string()`. Until decided, use `concat()`, which behaves the same in both runtimes.

Arithmetic on any other non-number is a runtime error.

> ⚠ **D6**: in non-strict mode `interp` coerces silently instead (`abs("x")` → `NaN`). `interp` has a `strictTypes` option that raises errors; `vm` always behaves strictly.

### 4.3 Comparison and equality

`< <= > >=` compare two numbers. `==` and `!=` compare type and value, with **no type coercion**: `1 == "1"` is `false`, and `nil == false` is `false`.

### 4.4 Logical operators

`!x` is `true` when `x` is falsy. `a && b` and `a || b` evaluate to booleans and **must short-circuit**: `b` is not evaluated when `a` decides the result.

> ⚠ **D16**: `interp` evaluates both operands; `vm` fails with "stack underflow" for any `&&` or `||` expression. Avoid both operators on the `vm` until fixed; nest `if` statements instead.

### 4.5 Assignment

`name = expr` assigns to an existing variable and evaluates to the assigned value, so `a = b = 5` sets both. Assigning to an undeclared name is an error.

> ⚠ **D3**: the `vm` silently creates a global instead of raising an error.

Only plain identifiers are assignment targets in v0 (no `a[i] = v` or `o.k = v`; see §8 for host calls).

### 4.6 Calls

`name(arg, …)` calls a user function declared with `function` or a built-in (§8). At most 255 arguments. Only identifiers can be called.

> ⚠ **D2**: calling a function declared **later in the file** fails: `interp` reports "Variable is not defined" and `vm` compiles it as a host call ("hostcall b not allowed"). Calls must resolve to every function declared anywhere at the top level.
> ⚠ **D3**: on the `vm`, an unknown name is only detected at runtime ("hostcall … not allowed"). It must be a compile-time error.

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

> ⚠ **D13**: a syntax error inside any statement is currently swallowed: the statement is replaced by `nil;` and parsing continues, so **broken code runs silently with parts missing**. A syntax error must stop compilation and report its line.

## 6. Scope and variables

- **Lexical block scoping.** Every block, function body and `for` loop opens a scope. An inner declaration shadows outer ones until the scope ends.
- Declaring the same name twice in one scope is an error.
- **Top-level variables are globals** and are visible inside functions declared anywhere in the file.

> ⚠ **D1** (**critical on `vm`**): the compiler stores top-level variables as local slots, so any function that reads or writes a top-level variable fails with "undefined global". `interp` behaves correctly except that it rejects a function body that refers to a global declared further down.

- Function parameters and `var`s inside a function are local to each call.
- There are no closures in v0. A nested function cannot capture the enclosing function's locals.

## 7. Errors

| Kind | When | Effect |
| --- | --- | --- |
| Lexical | unexpected character, unterminated string | compilation fails |
| Syntax | grammar violation | compilation must fail (⚠ **D13**) |
| Semantic | undefined name, duplicate declaration | compile-time on `interp`; `vm` partly at runtime (⚠ **D3**) |
| Runtime | type errors, division by zero, unknown host call, stack overflow, budget exceeded | unwinds to the nearest `try`; uncaught, the program stops with a message and source line |

`try { A } catch (e) { B }`: if a runtime error occurs in `A`, execution continues in `B` with `e` bound to the error. Errors that occur before execution (lexical, syntax, semantic) cannot be caught.

> ⚠ **D7**: the value bound to `e` is unspecified: `vm` binds the message string; `interp` binds an internal object that prints as `[object Object]`. Target: an object with `message`, `kind` and `line`.

**Limits.** Recursion beyond the call-depth limit is a runtime error (`vm`: 256 frames by default; stack depth 1024). Every execution must have a step and time budget.

> ⚠ **D10**: `vmrun` and `interp`/`runSource` have no default budget, so `while (true) {}` hangs. The PulsarOS runtime manager does apply budgets.

## 8. Built-in functions and host calls

Built-ins are called like functions. On the `vm` each call is a `HOST_CALL` checked against a whitelist (name, arity, argument kinds). On `interp` they are native functions.

> ⚠ **D5**: the two runtimes implement **different sets**: only 16 names exist in both, and several whitelisted `vm` names are not implemented by `vmrun` (they return `nil`). The interpreter's analyzer also rejects some of the interpreter's own natives. Phase 1 replaces both lists with one registry (`hostapi.yaml`). Until then, portable scripts should use only the ✓/✓ rows.

Results measured with `interp` (through the analyzer, as `runSource` does) and `vmrun` built from pulsaros-api `master`:

| Built-in | `interp` | `vm` | Behaviour |
| --- | --- | --- | --- |
| `typeOf(v)` | ✓ | ✓ | type name (§3) |
| `string(v)` | ✓ | ✓ | printable form |
| `len(s)` | ✓ | ✓ | string length |
| `concat(…)` | ✓ | ✓ | joins the printed forms of all arguments |
| `randomInt(a, b)` | ✓ | ✓ | integer in `[a, b]` |
| `number(s)` | ✓ | returns `nil` | parse a number |
| `abs(n)`, `clamp(n, lo, hi)` | ✓ | returns `nil` | |
| `floor` `ceil` `round` `sqrt` `pow` `min` `max` | ✓ | not allowed | |
| `toUpper` `toLower` `trim` `indexOf` `substr` | ✓ | not allowed | |
| `parseInt` `parseFloat` `toNumberOr` `isInteger` `isFinite` | ✓ | not allowed | |
| `clock()` `random()` | ✓ | not allowed | |
| `arrayLen` `arrayPush` `arrayPop` `arraySlice` `arrayConcat` `arrayIndexOf` | rejected by analyzer | ✓ | ⚠ **D15**: `arrayPush`/`arrayPop` do not change the array held in a variable |
| `objKeys` `objValues` `objHas` `objGet` `objSet` | rejected by analyzer | ✓ | |
| `kvGet` `kvSet` `kvDelete` | rejected by analyzer | host-defined | key-value store provided by the host |
| `fsRead` `fsWrite` `fsList` `fsStat` `fsDelete` `fsExists` | rejected by analyzer | host-defined | sandboxed file access provided by the host |
| `emitEvent` `pollEvent` | — | host-defined | event queue |
| `ipcSetContext` `ipcSend` | rejected by analyzer | host-defined | PulsarOS IPC; subject to the app's channel permissions |
| `registerHandler(name, fn)` | — | ✓ | registers an exported handler (inspect mode) |
| `loadModule(name)` | — | whitelisted, no effect | ⚠ **D8** |

"Host-defined" means the embedding host (the PulsarOS API's script manager, or `vmrun` with `-sandbox-root`) supplies the behaviour; `vmrun` alone returns `nil` or `false`.

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

> ⚠ **D9**: `vmrun -disasm` decodes `CALL` with one operand, so listings drift after the first call.

- `lineMap[i]` is the source line for `code[i]`, present when compiled with `-s`.
- There is no version field yet. Phase 1 adds a header `{format, version, compiler, sourceHash}`, and the loader will reject unknown versions.
- `YIELD`, `SLEEP`, `EMIT_EVENT` and `POLL_EVENT` exist in the VM but are never emitted by the compiler in v0.

## 11. Conformance

- `bun run conformance` runs every case on `interp`, and on the `vm` when `PULSARSCRIPT_VMRUN` points at a `vmrun` binary (`--require-vm` makes that mandatory).
- A case is `<name>.poo` plus `<name>.expected`: one line per printed value, then an optional `!error` or `!error: <kind>` line (`parse`, `semantic`, `runtime`, `compile`).
- Known defects are marked in the case with `// @xfail <runtimes> <defect> <note>`. A marked case that starts passing fails the run until the marker is removed, so fixes are never silent.

## 12. Defect register

| ID | Summary | Runtimes | Phase |
| --- | --- | --- | --- |
| D1 | Top-level variables compile as locals; functions cannot see globals | vm (interp: globals declared later) | 1 |
| D2 | Calls to functions declared later fail | both | 1 |
| D3 | Unknown names and undeclared assignment not caught at compile time | vm | 1 |
| D4 | Array and object literals unsupported | interp | 1 (or retire interp, A1) |
| D5 | Built-in sets differ; whitelisted VM built-ins return `nil`; the analyzer rejects interp natives | both | 1 |
| D6 | `+` with strings and implicit coercion differ | both | 1 |
| D7 | Caught error value unspecified | both | 1 |
| D8 | `loadModule` whitelisted but does nothing | vm | 3 |
| D9 | Disassembler mis-decodes `CALL` | vmrun | 1 |
| D10 | No default step/time budget in `vmrun` and `runSource` | both | 1 |
| D11 | PulsarOS frontend script calls cannot reach the API | integration | 4 |
| D12 | App manifest `script` shape differs between frontend and API | integration | 4 |
| D13 | Syntax errors are swallowed; statements silently dropped | both | 1 |
| D14 | Number formatting (`-0`, exponent form) | vm | 1 |
| D15 | `arrayPush`/`arrayPop` do not mutate the variable's array | vm | 2 |
| D16 | `&&`/`\|\|`: no short-circuit (interp), stack underflow (vm) | both | 1 |
| D17 | Arrays and objects print as `<?>` | vm | 2 |

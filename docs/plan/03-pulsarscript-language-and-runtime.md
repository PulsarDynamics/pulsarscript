# PulsarOS Development Plan — 03 · PulsarScript Language and Runtime

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

PulsarScript is correct and well tested; what it lacks is a memory limit and the features that make real app logic pleasant to write. This doc plans the remaining language work in four steps: memory limits and loader fuzzing now (G0 and G2, 2 days), **Language 1.0** with escapes, templates and closures (G4, 12 days), the **runtime and standard library** (G5, 14 days), and performance and compatibility (G7, 4.5 days). IDs refer to Doc 01 and Doc 08.

## Where the language stands

| | On `main` (SPEC v0.4) | After pulsarscript#18 (SPEC v0.5) |
| --- | --- | --- |
| Bytecode | version 1, 42 opcodes | version 2, 48 opcodes; the VM reads versions 0–2 |
| Registry (`vm/hostapi.json`) | 53 functions | 60 functions, 20 tied to a capability |
| Conformance cases | 122, passing on both runtimes | 159, passing on both runtimes |
| VM release | `vm/v0.4.0` | `vm/v0.5.0`, to tag after merge |
| Language | variables, functions, `if`/`while`/`for`, `try`/`catch`, arrays and objects as values | adds `a[i]`, `o.key`, element assignment, `%`, compound assignment, `break`/`continue`, `for…of`, `const`, functions as values |

All 19 audited defects are resolved and all seven original architecture decisions are approved. A4 (capabilities per host call) is implemented in pulsaros-api#53. A1 (the Go VM as the only runtime, built to WebAssembly for the browser) is the one with no code yet; DX-04 delivers it.

**Limits today:** 10 million steps and 10 s per run by default, 250,000 steps and 1.5 s per RPC call in the API, stack depth 1,024, call depth 256. Nothing limits memory (N1).

**Roadmap position:** Phases 0 and 1 are done. Phase 2 is roughly three quarters built (in #18). Phase 3 has its capability checks, file host calls, persistent storage and `notifyWindow` built in #53. Phases 5 and 6 have not started.

## G0 and G2 — Limits first

### LANG-01: memory limits (N1)

A seven-line loop that doubles a string 26 times allocated 134 MB inside the 250,000-step RPC budget; four more doublings would reach 2 GB. Steps and time do not bound memory, so memory needs its own budget.

- **What is counted:** string bytes at concatenation and at every built-in that returns a string; array and object growth; values returned by host calls, such as the result of `fsRead`; Base64 decoding.
- **Limits:** a cap on any single string, a cap on elements in one array or object, and an estimated total for the VM's live values. The existing heap-object limit, off by default, is turned on.
- **Failure:** an uncatchable `MemoryLimit` error with the line number, treated like a budget error: a script cannot `catch` it and carry on allocating.
- **Starting values, to tune against File Manager Lite traces:**

| Mode | Max string | Max elements per array or object | VM total |
| --- | --- | --- | --- |
| RPC call | 1 MiB | 100,000 | 16 MiB |
| Service | 4 MiB | 100,000 | 64 MiB |
| `vmrun`, REPL | 16 MiB | 1,000,000 | 256 MiB |

The string cap must not be smaller than the Base64 file-content cap that #53 sets for `fsRead`; align the two when implementing.

- **Tests:** the doubling loop as a conformance case on both runtimes; a test that process memory stays under the cap; one case per counted path.

### LANG-02: fuzz the loader

Installed apps bring bytecode from outside, and the API loads it after `VerifyModule`. Go's built-in fuzzer runs `LoadModule`, `VerifyModule` and run-with-budget on mutated copies of the conformance suite's bytecode. A short run on every PR, an hour nightly. Pass means no panic and no escape from the step, time or memory budget.

## G4 — Language 1.0

| Item | Feature | Design notes |
| --- | --- | --- |
| LANG-03 | String escapes | `\n`, `\t`, `\r`, `\\`, `\"`, `\u{…}`. An unknown escape is a compile error, so a typo never becomes a silent literal. This changes the meaning of any existing source that contains a backslash: scan the reference apps and examples first. Compiled bundles are unaffected |
| LANG-04 | Template literals | `` `Hi ${name}` `` compiles to concatenation under the D6 rule. Nested templates and escapes are supported; tagged templates are not |
| LANG-05 | Closures | Anonymous functions that capture variables, in the Lua style the Development Plan chose: a captured variable lives in an upvalue shared by the function that declared it and every closure over it. New opcodes for creating a closure, reading and writing an upvalue, and closing upvalues when a scope ends. Bytecode version 3. Values keep copy semantics (D15); only the variable slot is shared. Memory limits count closures. `registerHandler` by name keeps working, and also accepts a function value |
| LANG-06 | Better errors | Compile errors for unreachable code, duplicate declarations and wrong arity on known functions. Column numbers in compile errors. Runtime errors gain a `stack` field next to `{kind, line, message}`; it is an addition, so existing `catch` code keeps working |
| LANG-08 | Release | `SPEC.md` v1.0; at least 250 conformance cases; loader tests against stored version 0, 1 and 2 bundles; benchmark baseline (fib, loops, string building, array operations, handler dispatch); tag `v1.0.0` |

**Getting from 159 to 250 cases.** A working split of the 91 new cases: escapes 10, templates 12, closures 30, compile errors 12, memory limits 6, old-version loading 6, regressions found on the way 15.

**Closures are the risk.** The Development Plan put closures at about a third of Phase 2 and named them the feature most later work depends on; that is the 6 days here. Order of work inside LANG-05:

1. Anonymous function expressions with no capture (small, builds on v0.5's function values).
2. Capture of variables from the enclosing function, read and write.
3. Capture across more than one level, and closures created in loops.
4. Interpreter parity and the bytecode version bump.

If step 2 or 3 overruns, steps 1 and the rest of G4 can still ship as 1.0, with capture following as 1.1. G5's `on(event, fn)` and array functions need capture, so this would delay G5, not G4.

**Estimate note.** The Development Plan gave Phase 2 four weeks, and the File Manager plan's language milestone used the first three, which leaves about one week on paper. This plan budgets 12 days, because the largest Phase 2 item is still entirely ahead and the exit criteria (v1.0 spec, 91 more cases, version tests, benchmarks) have real cost.

## G5 — Runtime and standard library

### LANG-09: standard library

Everything is added through `hostapi.json`, so each function gets a type, docs, and compile-time checking for free.

| Area | Functions |
| --- | --- |
| Array | map, filter, reduce, find, sort with an optional comparator, slice, join, index-of, includes |
| String | split, replace, starts-with, ends-with, pad, repeat, index-of |
| Object | keys, values, entries, has, merge |
| JSON | parse, stringify |
| Time | now, format, parse |
| Math | whatever is missing after D5 |

Two choices to settle on the first day:

- **Names.** The registry today uses flat names (`arrayPush`, `toUpper`, `fsRead`, `kvGet`). The Development Plan writes `json.parse`. Recommendation: stay flat (`jsonParse`, `arrayMap`). Namespaces would need either module objects or compiler sugar, and one style is easier to learn. Decision A17 in Doc 09.
- **Functions that take functions.** `map`, `filter`, `reduce` and `sort` call back into script code. Either the VM learns to call a script function from inside a built-in, or these are written in PulsarScript and linked into bundles as a prelude. The prelude keeps the VM simple and counts steps naturally; the native route is faster. Recommendation: prelude first, measure, and move `sort` native if it is too slow.

### LANG-10: events

`on(event, fn)` registers a handler, `emit(name, payload)` sends, `sleep(ms)` and `yield` give up the VM. The compiler starts emitting the `YIELD`, `SLEEP`, `EMIT_EVENT` and `POLL_EVENT` opcodes that already exist. A service script becomes an event loop that the manager wakes, replacing polling. Budgets apply per wake-up, and a per-minute total (APP-06) stops a script that wakes constantly.

### LANG-11: async host calls

A host call may suspend the VM and resume it later with a result, so `fsRead` or `ipcSend` no longer hold the manager goroutine. Step, time and memory budgets carry across the suspension. A resumed VM re-checks that its app, user and scopes are still valid, because an uninstall or a revoked consent can happen while it waits.

### LANG-12: modules

`import { x } from "./util.puls"` is resolved by `fruit build` and linked into one bytecode file; the server never resolves imports. Import cycles and missing names are compile errors. Line maps record the source file, so errors name the right one. This replaces the `loadModule` call removed under D8.

### LANG-13: the exit test

The reference script (batch rename plus folder watcher, as FileManagerPro has) runs in RPC and service modes, using only specified features, inside default budgets. One thing to settle here: the installable-app work pages long jobs through RPC calls with a cursor instead of running them as services. With events and async host calls in place, decide which pattern the docs recommend and make File Manager Lite follow it.

## G7 — Performance and compatibility

| Item | What | Target |
| --- | --- | --- |
| LANG-07 | Stop copying the whole value on an element update such as `t.files += 1`; constant folding and peephole passes in the compiler; fewer `Value` copies in the VM loop | Faster than the G4 baseline on every benchmark; File Manager Lite below today's roughly 140 steps per folder entry |
| LANG-14 | Fuzz the parser and compiler nightly | No crash; every rejected input has a line number |
| LANG-15 | Compatibility policy | The VM loads bytecode versions N and N−1. A host call is deprecated for one minor release, with a compile warning, before removal. Legacy `.poo` sources and `.app` packages get an end date (Doc 04) |

Regressions above 10% on a tracked benchmark need a note in the PR, as the Development Plan's testing strategy already says.

**Later: LANG-16.** Once the REPL and Script Studio have run on the WebAssembly VM for one release, the TypeScript interpreter is retired. That ends the two-runtime parity work for good; until then, conformance on both runtimes stays a required check.

## Versions

| Release | Contents | Bytecode | Gate |
| --- | --- | --- | --- |
| `vm/v0.4.0` | Released; SPEC v0.4 | 1 | — |
| `vm/v0.5.0` | #18: indexing, members, loops, `const`, function values | 2 | G0 |
| `v0.6.0` | Memory limits; fuzzed loader | 2 | G2 |
| `v1.0.0` | Escapes, templates, closures, better errors; SPEC v1.0 | 3 | G4 |
| `v1.1.0` | Standard library, events, async host calls, modules | 3, or 4 if the event work needs new opcodes | G5 |
| `v1.2.0` | Performance work; compatibility policy in force | unchanged | G7 |

From `v1.0.0`, tag the repo as a whole (compiler, VM, spec and registry together), with `vm/vX.Y.Z` kept as the Go module tag at the same commit.

## Rules that carry over

1. Every language change starts as a spec diff plus conformance cases.
2. Every bug fix starts with a failing conformance case.
3. Every new host call needs a registry entry, a conformance case and a capability before it merges.
4. Golden bytecode changes are regenerated on purpose and reviewed as a diff.
5. A bytecode change bumps the version and adds an old-version loader test.

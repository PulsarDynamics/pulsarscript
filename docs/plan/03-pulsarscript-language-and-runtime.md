# PulsarOS Development Plan — 03 · PulsarScript Language and Runtime

23 Nov 2026 · Prepared for Berk Ormanlı · Status: language gates G0/G2/G4/G5/G7 implemented and verified in `pulsarscript` (v1.2.0)

PulsarScript now includes bounded memory limits, fuzzed bytecode/parser gates, **Language 1.0** (escapes, templates, closures, CoW collection updates, code-point string ordering, pragmatic syntax, column diagnostics & `stack`), the expanded **standard library, events, async host call suspend/resume, and build-time modules** (G5), plus compiler/VM performance optimizations and v0–v3 compatibility enforcement (G7). IDs refer to Doc 01 and Doc 08.

## Where the language stands

| | On `main` (SPEC v0.4) | After #18 (SPEC v0.5) | Completed (`v1.2.0` / SPEC v1.0) |
| --- | --- | --- | --- |
| Bytecode | version 1, 42 opcodes | version 2, 48 opcodes; v0–2 loaded | version 3, 52 opcodes (`CLOSURE`–`CLOSE_UPVALUE`, `sources`/`fileMap`); v0–3 loaded & tested |
| Registry (`vm/hostapi.json`) | 53 functions | 60 functions, 20 capability-gated | **97 functions** (77 `core`, 20 `host` across 6 capabilities; `deprecated` metadata supported) |
| Conformance cases | 122 | 159 | **285 cases**, passing 285/285 across `interp`, `vm`, and `wasm` |
| Benchmarks (Go VM) | — | 20k appends 2.2s, 10k keys 2.9s, 20k char walk cap | **20k appends 11.2 ms**, **10k keys 6.5 ms**, **51k Unicode char walk 10.8 ms**, `listSorted(200)` **133.4 steps/entry** (< 140); baseline saved in `docs/benchmarks-baseline.json` |
| Language | basic control flow & values | indexing, `%`, `break`/`continue`, `for…of`, `const`, fn values | escapes, templates, closures, CoW collections, string ordering, `/* */`, `?:`, `0x`/`1e3`, full stdlib, events, async suspend/resume, build-time `import`/`export` modules |

All 19 audited defects are resolved and all seven original architecture decisions are implemented (`A4` capabilities in `pulsaros-api#53`; `A1` WebAssembly Go VM & Script Studio built in `DX-04`; `LANG-16` interpreter retirement waits in *Later*).

**Limits today:** 10 million steps and 10 s per run by default, 250,000 steps and 1.5 s per RPC call in the API, stack depth 1,024, call depth 256. Nothing limits memory (N1). Probe measurements on `main` (`7619cb9`) also recorded two accepted runtime bounds (**L25**): walking a string character by character caps near ~20,000 characters per RPC call (mitigated by windowing, `LANG-09` string ops and `LANG-07`), and recursion stops at 256 calls deep (by design, D10).

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
| LANG-17 | CoW collection updates (N5) | Split out of `LANG-07` after probes showed every `a[len(a)] = v` or `o[k] = v` copies the whole value: 20,000 appends take 2.2 s, 10,000 object keys take 2.9 s, and ~7,000 object keys blow the 1.5 s RPC time budget while still far inside the 250,000-step budget. Copy-on-write or reference-counted backing preserves value/copy semantics (D15) with O(1) amortized unshared writes |
| LANG-18 | String ordering, nested indices & pragmatic v1.0 syntax (N6, A22) | Lexicographic string ordering (`<`, `<=`, `>`, `>=` by code point) so scripts can sort filenames; lift the `SemanticAnalyzer` restriction requiring a plain variable index in nested targets so `o.items[len(o.items)] = i` compiles; pragmatic v1.0 syntax: block comments `/* ... */`, ternary `?:`, and scientific/hex number literals (`1e3`, `0x...`) unified with `parseFloat` and `number()`. `++`, `switch`, and `do…while` stay excluded under A6 |
| LANG-08 | Release | `SPEC.md` v1.0; at least 280 conformance cases; loader tests against stored version 0, 1 and 2 bundles; benchmark baseline (fib, loops, string building, array/object building, handler dispatch); tag `v1.0.0` |

**Getting from 159 to 280 cases.** A working split of the 121 new cases: escapes 10, templates 12, closures 30, compile errors 12, memory limits 6, old-version loading 6, CoW aliasing and collection benchmarks 12, string ordering, nested indices and syntax (`/* */`, `?:`, `1e3`/`0x`, `parseFloat`/`number` parity) 18, regressions found on the way 15.

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
| Array | `arrayMap`, `arrayFilter`, `arrayReduce`, `arrayFind`, `arraySort` (uses string/number order with optional comparator), `arraySlice` (already in v0.5), `arrayJoin`, `arrayIncludes` |
| String | `split`, `replace`, `startsWith`, `endsWith`, `lastIndexOf`, optional `start` on `indexOf`, `padStart`, `padEnd`, `repeat`, `charCodeAt`, `fromCharCode` |
| Object | `objDelete`, `objEntries`, `objMerge` (alongside existing `objKeys`, `objValues`, `objHas`, `objGet`, `objSet`) |
| JSON | `jsonParse`, `jsonStringify` |
| Time | `dateFormat`, `dateParse` (alongside existing `clock`) |
| Math | `sin`, `cos`, `tan`, `atan2`, `log`, `log10`, `exp`, plus any constants/helpers missing after D5 |

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

The reference script ([`examples/file-manager-reference.puls`](../../examples/file-manager-reference.puls) + [`examples/file-manager-utils.puls`](../../examples/file-manager-utils.puls)) runs in both RPC (`listSorted`, `planRename`, `applyRenamePage` over 500 entries) and service modes (`on("fs.change", ...)` emitting `"watcher.summary"`), using only specified features, inside default budgets (`RPCVMConfig` and `ServiceVMConfig`).

**Pattern decision (settled):** Keep **cursor-paged RPC handlers** (`cursor`, `pageSize` -> `{nextCursor, done}`) for UI-initiated long batch operations (so windows receive incremental progress and fit comfortably within the 250,000-step / 1.5 s per-RPC budget), and reserve **event-driven services** (`on`/`emit` + async host calls via `ErrSuspended`/`ResumeAsync`) for background watchers and push notifications. File Manager Lite continues using cursor-paged RPC calls for interactive actions.

## G7 — Performance and compatibility

| Item | What | Target |
| --- | --- | --- |
| LANG-07 | Constant folding and peephole passes in the compiler; fewer `Value` copies in the VM loop; faster string indexing (`L25` walk path), building on `LANG-17`'s CoW updates | Faster than the G4 baseline on every benchmark; File Manager Lite below today's roughly 140 steps per folder entry |
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
| `v1.0.0` | Escapes, templates, closures, CoW collections, string ordering & pragmatic syntax, better errors; SPEC v1.0 | 3 | G4 |
| `v1.1.0` | Standard library, events, async host calls, modules | 3, or 4 if the event work needs new opcodes | G5 |
| `v1.2.0` | Performance work; compatibility policy in force | unchanged | G7 |

From `v1.0.0`, tag the repo as a whole (compiler, VM, spec and registry together), with `vm/vX.Y.Z` kept as the Go module tag at the same commit.

## Rules that carry over

1. Every language change starts as a spec diff plus conformance cases.
2. Every bug fix starts with a failing conformance case.
3. Every new host call needs a registry entry, a conformance case and a capability before it merges.
4. Golden bytecode changes are regenerated on purpose and reviewed as a diff.
5. A bytecode change bumps the version and adds an old-version loader test.

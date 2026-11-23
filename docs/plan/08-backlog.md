# PulsarOS Development Plan — 08 · Backlog

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

This is the work breakdown behind the master plan (Doc 00): 71 committed items, 108 developer-days, grouped by gate. Each item is one reviewable PR unless its row says otherwise. Estimates are single-developer days and are this plan's own; where the project docs already gave a figure, the Source column names it and Doc 00 compares the totals.

**How to read the table**

- **ID** — workstream prefix: `SEC` API security, `OPS` deployment and operations, `LANG` PulsarScript, `APP` installable-app platform, `FE` frontend, `DX` developer tooling, `QA` testing and CI, `REL` release and hygiene.
- **Source** — the finding, phase or plan item this comes from (IDs as in Doc 01). `new` marks work this plan adds.
- **Depends on** — items that must merge first. Empty means it can start any time inside its gate.

## Totals

| Gate | Goal | Items | Days |
| --- | --- | --- | --- |
| G0 | Safe to merge the installable-app PRs | 5 | 4.5 |
| G1 | API auth sweep | 10 | 5.5 |
| G2 | Deployable | 11 | 11.75 |
| G3 | App platform proven in a real browser | 10 | 14 |
| G4 | Language 1.0 | 5 | 12 |
| G5 | Runtime and standard library | 5 | 14 |
| G6 | Developer tooling | 6 | 15 |
| G7 | Hardening and performance | 6 | 9.75 |
| HT | Health track (about one day a week) | 13 | 21.5 |
| **Total** | | **71** | **108** |

Four more items are listed under *Later* and are not in the total.

## G0 — Safe to merge (4.5 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | C2 stop-gap: one filter on all three property write paths; keys compared after case folding; payloads with two keys that fold to the same name are rejected | C2 | API | 0.5 | | The audit's reproduction returns 403 for `acc.admin`, `Acc.Admin`, `ACC.ADMIN` and `appstore.publishers` variants on `POST /v1/user/properties/update`, `PUT /v2/users/me` and `POST /v2/users` |
| SEC-02 | C2 proper: server-owned `user_roles` and `publisher_members` tables; one `authz` package used by `checkAdminAccess`, `canManagePublisher`, `isAdmin`, the #53 upload check and `RequireAdmin`; admin granted only by CLI or bootstrap variable; reviewed backfill | C2, M4 | API | 1.5 | SEC-01 | No code path reads a role from `properties`; a granted admin reaches a `RequireAdmin` route; a user with self-written flags does not |
| SEC-03 | Untrack `data/*.db`, `data/*.sqlite` and `bin/`; ignore them; refuse to start without `DB_NAME` outside development; rotate the owner's password; decide on a history purge | C3 | API | 0.5 | | A fresh clone has no database; the server exits with a clear error when `DB_NAME` is unset and `ENV` is not `dev` |
| LANG-01 | VM memory limits: caps on string length, array and object size, and a per-VM heap estimate; exceeding one raises an uncatchable `MemoryLimit` error; per-mode values in the API | N1, Phase 3 | PulsarScript, API | 1 | | The seven-line string-doubling loop fails with `MemoryLimit` and a line number on both runtimes; process memory stays under the configured cap |
| APP-01 | Merge train: merge pulsarscript#18, tag `vm/v0.5.0`, re-pin and merge pulsaros-api#53, merge pulsaros#60; smoke test; refresh the landing page figures | Plan M0–M7, L5 | All | 1 | SEC-02 | All three default branches green; the API's `go.mod` names `vm/v0.5.0`; `hello.pulsar` installs and opens against `master` + `main` |

## G1 — API auth sweep (5.5 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-04 | Auth plus a publisher or admin check on collection writes, asset upload and delete, and download records | H1 | API | 1 | SEC-02 | Each route returns 401 without a token and 403 for a non-member |
| SEC-05 | Route-table guard test: walk every registered route; fail if a non-GET route answers without a token unless it is on a short, reviewed public list | H1, new | API | 0.5 | SEC-04 | The test fails when an unauthenticated write route is added to `main.go` |
| SEC-06 | Reject deleted users at login and in `ValidateToken`; delete their tokens in `DeleteUser`; decide whether usernames are released | H3 | API | 0.5 | | A deleted user's password and old tokens both return 401 |
| SEC-07 | Trust `X-Forwarded-For` and `X-Real-IP` only from `TRUSTED_PROXIES`; add a per-username limiter | H4 | API | 0.5 | | Rotating the header from an untrusted address does not reset the limit |
| SEC-08 | Global `http.MaxBytesReader`; per-file size cap; real quota checked before every write | H5 | API | 1 | | An oversized body returns 413; a write past the quota returns 507 or 413 and stores nothing |
| SEC-09 | Re-hash legacy SHA-256 passwords to bcrypt on login; constant-time compare; count remaining legacy hashes; forced reset after a deadline | H7 | API | 0.5 | | After one login the stored hash is bcrypt; the legacy path is gone for that user |
| SEC-10 | `/v1/users/get` requires auth, or returns only the login-screen fields | M6 | API | 0.25 | | Anonymous call returns 401 or the reduced shape |
| SEC-11 | Match review routes by path segment; fix `POST /api/sites` being shadowed by the list handler | M5, M4 | API | 0.25 | | `POST …/reviews/5/helpful` records a vote and creates no review |
| SEC-12 | FiveM: per-server keys and `subtle.ConstantTimeCompare`; same compare for `AUTH_CODE` | M8, L13 | API | 0.5 | | A key for server A is refused with `X-Server-Id: B` |
| SEC-13 | Store a SHA-256 of each session token; purge expired rows on a timer | L1 | API | 0.5 | | The `tokens` table holds no usable token; expired rows disappear |

## G2 — Deployable (11.75 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| OPS-01 | Migration runner (goose or golang-migrate) with a tracking table for SQLite and Postgres; baseline existing databases; move `app_kv` creation into a migration; test schemas built from migrations | M3, M11 | API | 2 | SEC-02 | An empty database of either kind reaches the current schema with one command; running it twice changes nothing |
| OPS-02 | Postgres booleans in `message`; sweep for other SQLite-only SQL; run service tests on both drivers in CI | M2 | API | 1 | OPS-01 | Message read and delete pass on Postgres in CI |
| OPS-03 | CORS as the outermost layer; one `AUTH_CODE` mechanism that the frontend and app windows can both satisfy | M1, N2 | API, frontend | 1 | | A cross-origin preflight succeeds with `AUTH_CODE` set; an installed app's UI loads in protected-server mode |
| OPS-04 | `LISTEN_ADDR`; keep `ARCOS_LISTEN_CONFIG_OVERRIDE` as a deprecated alias; `sslmode=require` for non-local hosts; build the DSN with `net/url` | M10, L17 | API | 0.5 | | The server is reachable in a container with only documented variables; a password with spaces connects |
| OPS-05 | `ReadHeaderTimeout`; clear the write deadline on streaming routes with `http.ResponseController`; graceful shutdown | H9 | API | 0.5 | | The PulsarIMS alert stream stays open for 5 minutes; a slow-header client is dropped |
| OPS-06 | Container image (multi-stage, non-root), compose file with Postgres, readiness endpoint, configuration reference, single-replica rule written down | M9, M10, new | API | 1.5 | OPS-01, OPS-04 | `docker compose up` gives a working API on Postgres from a clean checkout |
| OPS-07 | Staging environment and deploy pipeline on the chosen platform; secrets store; database and user-file backups with one restore drill | new | API, frontend | 2 | OPS-06 | A merge to the default branch reaches staging without manual steps; a restore from backup is rehearsed once |
| OPS-08 | Observability baseline: structured logs with request IDs, counters for auth failures, budget and memory kills, VM count, and error reporting | new | API | 1 | | A failed login, a killed script and a 500 are each visible in the logs with one request ID |
| QA-01 | `-race` in API CI; coverage uploaded with a ratchet that cannot go down | Analysis rec. 10 | API | 0.25 | | CI fails on a data race and on a coverage drop |
| LANG-02 | Fuzz `LoadModule`, `VerifyModule` and run-with-budget; nightly CI job | Phase 6, Analysis rec. 5 | PulsarScript | 1 | LANG-01 | One hour of fuzzing: no panic, no budget or memory escape |
| REL-01 | Remove tracked generated files and clutter in both PulsarOS repos; archive root-level planning files; fix `.gitmodules` and `CLAUDE.md`; drop unused dependencies and dead code | L2, L20–L23 | API, frontend | 1 | | Repo roots hold only code, config and current docs |

## G3 — App platform proven in a real browser (14 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| QA-02 | Playwright against a live API in CI (Chromium and Firefox): sign in, install File Manager Lite, run its M6 scenario, update, uninstall; sandbox assertions | N4, Plan M6, Phase 4 | Frontend, API | 3 | APP-01 | The job is required on PRs to pulsaros and pulsaros-api |
| APP-02 | App UI origin isolation: serve UIs from a dedicated origin and pin window navigation to it; revoke the app's port on navigation | N3 | API, frontend | 2.5 | QA-02 | A Playwright test shows an app that sets `location.href` to another site is blocked or stopped before it receives data |
| APP-03 | SDK version contract: the SDK announces its version in `app.ready`; the host negotiates; `fruit build` stamps it into the manifest; validation warns on stale copies | Analysis (contracts), new | Frontend, API | 1 | APP-01 | A bundle with an unsupported SDK major is refused with a readable message |
| APP-04 | Contract checks in CI: `hostapi.json` against the API script host for every entry; manifest schema fixtures shared by all three repos | Analysis (contracts) | All | 0.5 | APP-01 | Adding a host call to the registry without a host implementation fails API CI |
| FE-01 | Bug reports through a server endpoint; delete the `VITE_PB_ADMIN_*` path; make the report host configurable | H6 | Frontend, API | 1 | | The built bundle contains no PocketBase admin variable names |
| FE-02 | Remove the third-party frame check in Web Browser, or serve it from the API | M14 | Frontend | 0.5 | | No request leaves for `ifc.izaak-kuipers.workers.dev` |
| FE-03 | Write user CSS through `textContent` instead of `{@html}` | F4 | Frontend | 0.5 | | `</style><img onerror>` in user CSS renders no element |
| FE-04 | One sanitizer; drop `style`; add `rel="noopener noreferrer"`; audit the remaining `{@html}` sinks | F5 | Frontend | 0.5 | | One sanitizer module is imported everywhere; unit tests cover each sink |
| FE-05 | Fix or delete the 17 components that do not compile; make `Button` forward `on:click`; shrink the ESLint ignore list | F13 | Frontend | 1.5 | | `svelte-check` parses every file in `src/lib/Components` |
| APP-05 | In-OS developer console: per-app script logs, VM list, errors with source line and snippet | Phase 4 | Frontend, API | 3 | APP-01 | A handler error in an installed app shows its `.puls` line in the console |

## G4 — Language 1.0 (12 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| LANG-03 | String escapes: `\n`, `\t`, `\r`, `\\`, `\"`, `\u{…}`; unknown escapes are compile errors | Phase 2 | PulsarScript | 1 | APP-01 | Conformance cases on both runtimes; the first-app guide drops its `trim(ch) == ""` workaround |
| LANG-04 | Template literals `` `Hi ${name}` `` | Phase 2 | PulsarScript | 1.5 | LANG-03 | Conformance cases including nesting and escapes |
| LANG-05 | Closures: anonymous functions and captured variables (upvalues); bytecode v3; interpreter parity | Phase 2, A6 | PulsarScript | 6 | LANG-01 | Counter, callback and nested-capture cases pass on both runtimes; v0–v2 bundles still load |
| LANG-06 | Compile errors for unreachable code, duplicate declarations and wrong arity; column numbers; stack in runtime errors | Phase 2, Analysis | PulsarScript | 1.5 | | Each error kind has a conformance case with line and column |
| LANG-08 | `SPEC.md` v1.0; at least 250 conformance cases; loader tests with stored v0, v1 and v2 bundles; benchmark baseline recorded | Phase 2 exit | PulsarScript | 2 | LANG-03, LANG-04, LANG-05, LANG-06 | Phase 2 exit criteria met in CI; `v1.0.0` tagged |

## G5 — Runtime and standard library (14 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| LANG-09 | Standard library through the registry: array (map, filter, reduce, sort, find, slice, join), string, object, JSON parse and stringify, time | Phase 3 | PulsarScript, API | 4 | LANG-05 | Every function has a registry entry, a conformance case and docs |
| LANG-10 | Event model: `on(event, fn)`, `emit`, `sleep(ms)`, `yield`; service scripts run as an event loop | Phase 3 | PulsarScript, API | 3 | LANG-05 | A service wakes on an event without polling and stays inside its budget |
| LANG-11 | Async host calls: a host call suspends the VM and resumes it with a result; budgets hold across resumes | Phase 3 | PulsarScript, API | 3 | LANG-10 | A slow `fsRead` does not block another VM's call |
| LANG-12 | Build-time modules: `import { x } from "./util.puls"` linked into one bundle by `fruit build`; cycles rejected | Phase 3, D8 | PulsarScript, API | 3 | LANG-08 | A two-file app builds to one bytecode file; a cycle is a compile error |
| LANG-13 | Reference script (batch rename plus folder watcher) in RPC and service modes inside default budgets; settle cursor paging against services for long jobs | Phase 3 exit | PulsarScript, API | 1 | LANG-09, LANG-10, LANG-11 | Phase 3 exit criterion met in CI |

## G6 — Developer tooling (15 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| DX-01 | Formatter (`fruit fmt`) | Phase 5 | PulsarScript | 2 | LANG-08 | Formatting the conformance suite is idempotent and changes no output |
| DX-02 | Linter: unused variables, shadowing, unknown host calls, host call without its capability in the manifest | Phase 5 | PulsarScript | 2 | LANG-08 | Each rule has a failing and a passing fixture |
| DX-03 | Language server (diagnostics, completion, hover from `hostapi.json`) and a VS Code extension | Phase 5 | PulsarScript | 4 | DX-02 | Completion lists the 60+ registry functions with types |
| DX-04 | Go VM built to WebAssembly; Script Studio app with output, disassembly and budget meters | Phase 5, A1 | PulsarScript, frontend | 4 | LANG-08 | A script runs in the browser with the same output as `vmrun` for the whole conformance suite |
| DX-05 | Debugger in Script Studio: breakpoints and stepping on line maps | Phase 5 | PulsarScript, frontend | 2 | DX-04 | Stop at a line, inspect locals, step over a call |
| DX-06 | Docs site generated from `SPEC.md`, the registry and conformance examples; refreshed first-app guide and SDK reference | Phase 5 | PulsarScript, API | 1 | | A developer new to PulsarOS writes, tests and debugs a handler from the docs alone |

## G7 — Hardening and performance (9.75 d)

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| LANG-07 | Performance: avoid whole-value copies on element updates, constant folding, peephole passes, fewer `Value` copies in the VM loop | Phase 6, Analysis | PulsarScript | 3 | LANG-08 | Benchmarks beat the G4 baseline; File Manager Lite uses fewer steps per folder entry than today's 140 |
| LANG-14 | Fuzz the parser and compiler nightly | Phase 6 | PulsarScript | 1 | LANG-02 | No crash in a nightly run |
| SEC-14 | Security review of the host layer: capabilities, `fs*` path handling, IPC scope, resource caps | Phase 6 | API | 2 | LANG-11 | Every finding is fixed or recorded with a decision |
| APP-06 | Per-app quotas (CPU time per minute, VM count, key-value size) and telemetry dashboards | Phase 6 | API | 2 | OPS-08 | An app over quota is throttled and the event is visible on a dashboard |
| LANG-15 | Compatibility policy: bytecode versions N and N−1; deprecation process for host calls | Phase 6 | PulsarScript | 0.5 | | The policy is in `SPEC.md` and enforced by a loader test |
| FE-06 | Immutable updates in `ProcessHandler`; `Button` forwards `$$restProps`, with `title` and `aria-label` on icon-only buttons | F9, F12 | Frontend | 1.25 | | No Map-to-Array copies in templates; icon buttons have accessible names |

## HT — Health track (21.5 d)

Scheduled at about one day a week from week 3, in the order below.

| ID | Item | Source | Repo | Days | Depends on | Acceptance test |
| --- | --- | --- | --- | --- | --- | --- |
| FE-12 | Batch of small frontend bugs: PulsarMDT `authenticate()`, `bootstrapped`, `issueid`, compose error fields, `dependendsOn`, FiveM `postMessage` origin, notification `{@html}` | L6–L12 | Frontend | 1.5 | | One test per bug |
| SEC-15 | Batch of small API bugs: `GetMessage` nil checks, `LIKE` wildcards in moves, `SafeJoin` false positive, script manifests read from the registry, pulsarnetwork random source | L14–L16, L18, L19 | API | 1.5 | | One test per bug |
| QA-03 | Service tests for the seven App Store packages without any; raise `services/appstore` from 8% | Analysis (testing) | API | 3 | SEC-04 | Each package has tests; the coverage ratchet moves up |
| QA-04 | Smoke test: open each of the 41 built-in apps in Playwright and assert no uncaught error | new | Frontend | 1 | QA-02 | The job lists every app it opened |
| FE-07 | Run search providers with `Promise.allSettled` | F7 | Frontend | 0.5 | | A slow provider does not delay the others |
| FE-08 | `closedPids` as a `Set`; drop PIDs when the process is gone | F8 | Frontend | 0.5 | | The set is empty after all windows close |
| FE-09 | Modal: `role="dialog"`, `aria-modal`, label, Escape, focus trap and restore | F10 | Frontend | 0.5 | | Keyboard-only test passes |
| FE-10 | Input: labels tied by `id`, `aria-invalid`, `aria-describedby` | F11 | Frontend | 0.5 | | Unit test on the rendered attributes |
| FE-11 | Burn down the `svelte-check` baseline (512) and ESLint suppressions (76) area by area; delete unused generated components | M15 | Frontend | 5 | FE-05 | Zero errors in files the app loads; CI gates on zero for those files |
| FE-13 | Move the session from `localStorage` to an HttpOnly cookie | Audit C4 (long term), Analysis | Frontend, API | 3 | SEC-13, OPS-03 | No token is readable from page script; the 38 `localStorage` call sites no longer touch it |
| FE-14 | Split the 1.1 MB main chunk: load apps on first open | Analysis, new | Frontend | 1.5 | QA-04 | Initial JavaScript is under half of today's size |
| REL-02 | One name: Go module path, binary, `/health` text, environment variables with deprecated aliases | L3 | API, frontend | 1 | OPS-06 | No `arcos` or `fruitos` string in user-visible output |
| FE-15 | Svelte 5 and Vite upgrade: written migration plan and a spike on one app | L4 | Frontend | 2 | FE-11 | A go or no-go decision with an estimate |

## Later (not in the total)

| ID | Item | Source | Repo | Days | Trigger |
| --- | --- | --- | --- | --- | --- |
| APP-07 | Bundle signatures (the `manifest_signature` column exists) and publishing open to registered publishers | Plan risks, Plan Q2 | API, frontend | 3 | Before any non-admin publishes |
| OPS-09 | Move in-memory state (IPC registry, script VMs, event hub, rate limiters) out of the process | M9 | API | 5 or more | Only when a second replica is needed |
| LANG-16 | Retire the TypeScript interpreter once the REPL and Script Studio run on the WebAssembly VM | A1 | PulsarScript | 1.5 | After DX-04 has run for one release |
| APP-08 | SDK design for dragging files out of an app window | Plan Q5 | Frontend | 2 (design only) | After G3, if users ask for it |

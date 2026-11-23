# PulsarOS Development Plan — 01 · Findings and Defect Register

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

Every finding, defect and planned fix from the five project docs is listed here once, with its status on 23 November 2026 and the backlog item (Doc 08) and gate (Doc 00) that closes it. The project docs track these in four separate tables with overlapping ID letters; this register is the single list to update from now on.

**Counts on 23 November 2026 (reconciled):** 53 items are open or partly fixed (1 critical, 8 high, 21 medium, 23 low), 34 are closed (11 audit findings, all 19 language defects, 4 frontend changes), and 1 is accepted (L25). The medium count treats the eight remaining frontend changes (F4, F5, F7–F12) as one item, as the analysis does. The 23 open low items include 18 from the audit's unnumbered "low findings" list (L6–L23).

## ID families

| Prefix | Meaning | Defined in |
| --- | --- | --- |
| C1–C5, H1–H9, M1–M15 | Audit findings: critical, high, medium | Audit Report |
| N1–N8 | Findings new since the audit (N5–N8 from Markdown Viewer & PulsarScript probe) | Audit Report, Detailed Analysis, 23 Nov probe |
| L1–L5 | Low items numbered by the analysis | Detailed Analysis |
| L6–L25 | Low findings and hygiene from the audit (L6–L23) and 23 Nov probe (L24–L25) | Audit Report, 23 Nov probe |
| D1–D19 | PulsarScript defects | Development Plan |
| F1–F13 | Frontend hardening changes | Development Plan |
| A1–A11 | Architecture decisions (A12 onward are proposed in Doc 09) | Development Plan, File Manager plan |
| Phase 0–6 | PulsarScript roadmap phases | Development Plan |
| Plan M0–M7 | Installable-app milestones. Written "Plan M3" here, because the audit also uses M1–M15 | File Manager plan |
| G0–G7, HT | This plan's gates and health track | Doc 00 |

## Critical and high

| ID | Finding | Severity | Status | Repo | Closed by | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Unauthenticated file read | Critical | Fixed | API | — | — |
| C2 | Any user can make themselves admin through their own properties JSON; the same check gates `.pulsar` publishing in #53 | Critical | Fixed 23 Nov: roles live in `user_roles` and `publisher_members` (internal/authz); every admin check, including `POST /v1/appstore/bundles`, asks authz; properties grant nothing; admin granted with `pulsaros-api admin grant <username>` (pulsaros-api#54, #58) | API | SEC-01, SEC-02 | G0 |
| C3 | Committed database with a `test`/`test` login is the default; 15 MB binary tracked | Critical | Partly fixed 23 Nov: DBs and binary untracked and server refuses to start without `DB_NAME` (pulsaros-api#55); git history purge (Q4) and password rotation remain | API | SEC-03 | G0 |
| C4 | Stored XSS through messages | Critical | Fixed | Frontend | — (long-term cookie move: FE-13) | — |
| C5 | `dev-ecs` frontend does not build | Critical | Fixed | Frontend | — | — |
| H1 | App Store writes without a token: collections, asset upload and delete, download records | High | Partly fixed | API | SEC-04, SEC-05 | G1 |
| H2 | App installs IDOR | High | Fixed | API | — | — |
| H3 | Deleted accounts still sign in and keep their tokens | High | Open | API | SEC-06 | G1 |
| H4 | Rate limits trust forwarded headers from anyone | High | Open | API | SEC-07 | G1 |
| H5 | No body limits outside the app routes; no quota check before writes | High | Partly fixed | API | SEC-08 | G1 |
| H6 | PocketBase superuser credentials reach browsers if `VITE_PB_ADMIN_*` is set | High | Open | Frontend | FE-01 | G3 |
| H7 | Legacy unsalted SHA-256 passwords accepted forever | High | Open | API | SEC-09 | G1 |
| H8 | No working CI | High | Fixed | All | — | — |
| H9 | Server timeouts: the 30 s write timeout cuts the PulsarIMS alert stream; no `ReadHeaderTimeout` | Medium (was High; re-rated by the analysis after the partial fix) | Partly fixed | API | OPS-05 | G2 |
| N1 | Scripts can allocate unbounded memory: 134 MB inside one RPC call's step budget | High | **Fixed** (uncatchable string/collection/heap/memory caps in VM & Interpreter, `vmrun` flags, `FuzzLoadModuleAndRun`) | PulsarScript | LANG-01, LANG-02 | G0, G2 |
| N5 | Building arrays and objects is quadratic: whole-value copies on element updates cause ~7,000 object keys to blow the 1.5 s RPC time budget well inside the 250k step budget | High | **Fixed** (Conchon–Filliâtre CoW arrays/objects preserving D15 semantics: 20k appends 11.2 ms, 10k object keys 6.5 ms) | PulsarScript | LANG-17 | G4 |

## Medium

| ID | Finding | Status | Repo | Closed by | Gate |
| --- | --- | --- | --- | --- | --- |
| M1 | CORS preflights fail when `AUTH_CODE` is set | Open | API | OPS-03 | G2 |
| M2 | Message read and delete fail on Postgres (`= 1` on booleans) | Open | API | OPS-02 | G2 |
| M3 | No migration runner; the server applies no schema | Open | API | OPS-01 | G2 |
| M4 | `RequireAdmin` can never pass; `POST /api/sites` is shadowed | Partly fixed 23 Nov: `RequireAdmin` switched to `authz.IsAdmin` (pulsaros-api#58); `POST /api/sites` shadow remains | API | SEC-02, SEC-11 | G0, G1 |
| M5 | Review routes match by substring, so a "helpful" vote creates a review | Open | API | SEC-11 | G1 |
| M6 | `/v1/users/get` lists every user without a login | Open | API | SEC-10 | G1 |
| M7 | IPC devices not bound to their owner | Fixed | API | — | — |
| M8 | FiveM servers share one key, compared with `!=` | Open | API | SEC-12 | G1 |
| M9 | In-memory state blocks a second replica; grew with script VMs and the event hub | Open, accepted for now | API | OPS-06 (run one replica), OPS-09 (later) | G2 |
| M10 | Binds to localhost; Postgres TLS off by default | Open | API | OPS-04 | G2 |
| M11 | Tests stale or brittle | Fixed | API | — | — |
| M12 | Interpreter lags the compiler | Fixed | PulsarScript | — | — |
| M13 | Builds not reproducible | Fixed | All | — | — |
| M14 | Web Browser sends every URL to a third-party worker | Open | Frontend | FE-02 | G3 |
| M15 | 512 `svelte-check` errors and 76 ESLint suppressions, held at a baseline | Partly fixed | Frontend | FE-11 | HT |
| N2 | `AUTH_CODE`: the server reads a header, the frontend sends `?ac=`, app windows can send neither | Open | API, frontend | OPS-03 | G2 |
| N3 | An installed app's window can navigate itself and carry out what it has read | Open | Frontend, API | APP-02 | G3 |
| N4 | No browser end-to-end test in any repo | Open | All | QA-02, QA-04 | G3, HT |
| F13 | 17 UI library components do not compile; `TreeView` is broken | Open | Frontend | FE-05 | G3 |
| — | Language gaps: string escapes, templates, closures, standard library, modules | **Fixed** (all delivered in PulsarScript v1.0–v1.2, 285 conformance cases on both runtimes) | PulsarScript | LANG-03 to LANG-13 | G4, G5 |
| N6 | Scripts cannot order strings (`"a" < "b"` errors) or delete object keys; nested index assignment rejects non-variable indices (`o.items[len(o.items)] = i`); `number("1e3")` vs `parseFloat`/literals mismatch | **Fixed** (code-point string ordering, `objDelete`/stdlib, arbitrary nested index keys, `/* */`, `?:`, hex/exp literals) | PulsarScript | LANG-18, LANG-09 | G4, G5 |
| N7 | Apps lack a scoped file picker or Open / Open with launch (forcing `fs.user` on Markdown Viewer), have no light/dark `scheme` in theme events, and cannot open URLs except via clipboard | Open | API, Frontend | APP-10, APP-09 | G3, G5 |
| N8 | No local mock-host `fruit dev` or `.pulsar` `fruit create` templates; window console logs go nowhere; apps lack shared layout CSS and a self-hosted icon font (Google Fonts blocked by CSP) | Open | API, Frontend | APP-05, APP-11, DX-07 | G3, G5, G6 |

## Low

L6–L23 come from the audit of 22 November and were **not** re-checked on 23 November. The first step of each batch item is to confirm the bug still exists on the default branch.

| ID | Finding | Status | Repo | Closed by | Gate |
| --- | --- | --- | --- | --- | --- |
| L1 | Session tokens stored in plain text and never purged | Open | API | SEC-13 | G1 |
| L2 | Generated files tracked: `coverage.html`, `sites.go.bak` | Open | API | REL-01 | G2 |
| L3 | Names mix FruitOS, ArcOS and PulsarOS (module path, binary, `/health`, environment variables) | Open | API, frontend | REL-02 | HT |
| L4 | Svelte 4 and Vite 4 | Open | Frontend | FE-15 (plan and spike) | HT |
| L5 | The API pins an untagged VM commit (in #53) | Fixed 23 Nov: `vm/v0.5.0` tagged on the pulsarscript#18 merge commit; `go.mod` requires it. The untagged pin had made every API CI run fail since #58 | API | APP-01 | G0 |
| L6 | `PulsarMDT.authenticate()` always returns true and calls a `dispatch.send` that does not exist | To verify | Frontend | FE-12 | HT |
| L7 | `ensureSystemFoldersBootstrap` assigns an undeclared `bootstrapped` (never called) | To verify | Frontend | FE-12 | HT |
| L8 | Bug-report lookup reads `issueid`; the field is `issuedid` | To verify | Frontend | FE-12 | HT |
| L9 | Message-compose error path reads fields that `MessageSendResult` does not have | To verify | Frontend | FE-12 | HT |
| L10 | `dependendsOn` typo in 8 manifests and the loader | To verify | Frontend | FE-12 | HT |
| L11 | FiveM `message` listener accepts `postMessage` from any origin | To verify | Frontend | FE-12 | HT |
| L12 | Message notifications render `{@html}` after stripping a few characters | To verify (the audit saw it on `dev-ecs` only) | Frontend | FE-12 | HT |
| L13 | `AuthCode` compares with `!=` | To verify | API | SEC-12 | G1 |
| L14 | `GetMessage` dereferences sender and receiver without nil checks | To verify | API | SEC-15 | HT |
| L15 | File moves build a `LIKE` pattern from user paths; `%` and `_` act as wildcards | To verify | API | SEC-15 | HT |
| L16 | `SafeJoin` rejects any name starting with `..`, such as `..notes` | To verify | API | SEC-15 | HT |
| L17 | Postgres DSN built with `fmt.Sprintf` | To verify | API | OPS-04 | G2 |
| L18 | Script manifests load from `USERFILES_DIR/<appID>/`, the user-file tree, and scopes come from that file | To verify (later docs name `SCRIPT_APPS_DIR` and installed versions) | API | SEC-15 | HT |
| L19 | pulsarnetwork nonces and IDs use `math.random` | To verify | pulsarnetwork (Lua) | SEC-15 | HT |
| L20 | pulsaros `.gitmodules` lists 36 unregistered submodules; `CLAUDE.md` gives stale clone steps | To verify | Frontend | REL-01 | G2 |
| L21 | `internal/config.Config` mostly unused; `cmd/server/setup.go` duplicates `main` | To verify | API | REL-01 | G2 |
| L22 | Unused frontend dependencies (`math.js`, `svelte-closable`); `serve` in runtime dependencies | To verify | Frontend | REL-01 | G2 |
| L23 | About 20 AI-generated planning files in each repo root; other clutter (`sample.app`, `test-blank/`, `demo-reload-test/`, `matchcheck/`) | To verify | API, frontend | REL-01 | G2 |
| L24 | App Store details modal renders empty screenshots, features, size, verified badge and long description, and reads legacy `script.exports.handlers` instead of `script.handlers` | Open | Frontend, API | FE-16 | G3 |
| L25 | Character-by-character string walk caps near 20,000 characters per RPC call; recursion stops at 256 calls deep | Accepted (by design, D10; mitigated by windowing, `LANG-09` string ops and `LANG-07`) | PulsarScript | — | — |

## Frontend hardening track (F1–F13)

| ID | Change | Priority | Status | Closed by | Gate |
| --- | --- | --- | --- | --- | --- |
| F1 | "Remember me" keeps a session token, not the password | P0 | Merged (pulsaros#58) | — | — |
| F2 | Password change: `POST` with `{old, new}`, old password verified, other sessions ended | P0 | Merged (pulsaros-api#52, pulsaros#58) | — | — |
| F3 | File names cannot inject markup through `DataTable` | P0 | Merged (pulsaros#59) | — | — |
| F4 | CSS injection through `{@html}` user style | P1 | Planned | FE-03 | G3 |
| F5 | One sanitizer; drop `style`; `rel` on new-tab links; audit other sinks | P1 | Planned | FE-04 | G3 |
| F6 | CI for pulsaros | P0 | Merged (pulsaros#57) | — | — |
| F7 | Search providers in parallel | P2 | Planned | FE-07 | HT |
| F8 | `closedPids` as a `Set` | P2 | Planned | FE-08 | HT |
| F9 | Immutable `ProcessHandler` updates | P3 | Planned | FE-06 | G7 |
| F10 | Modal accessibility | P2 | Planned | FE-09 | HT |
| F11 | Input accessibility | P2 | Planned | FE-10 | HT |
| F12 | Button forwards props; icon buttons get names | P3 | Planned | FE-06 | G7 |
| F13 | 17 components that do not compile | P2 | Planned | FE-05 | G3 |

The Development Plan (22 Nov) lists F1–F3 and F6 as "in review"; the landing page and the analysis (23 Nov) record them as merged. This register follows the later docs.

## PulsarScript defects (D1–D19)

All 19 are resolved on `main`; none is open. They stay here so the IDs remain searchable.

| ID | Defect | Resolution |
| --- | --- | --- |
| D1 | Top-level variables invisible inside functions | Fixed, pulsarscript#11 |
| D2 | Forward calls fail | Fixed, pulsarscript#11 |
| D3 | Unknown names compile as host calls | Fixed, SPEC v0.3: resolved against `hostapi.json` at compile time and at load |
| D4 | Arrays and objects crash the interpreter, REPL and analyzer | Fixed, pulsarscript#12 |
| D5 | Built-in sets diverge between runtimes | Fixed, SPEC v0.3: one registry |
| D6 | `+` semantics differ | Fixed by decision, SPEC v0.2: concatenates when either side is a string |
| D7 | Caught errors not readable | Fixed by decision, SPEC v0.2: `e` is `{kind, line, message}` |
| D8 | `loadModule` whitelisted but does nothing | Closed, SPEC v0.3: removed until modules exist (LANG-12) |
| D9 | Disassembler mis-decodes `CALL` | Fixed: one opcode table |
| D10 | No default budget in `vmrun` and `runSource` | Fixed, SPEC v0.3: 10 M steps, 10 s, 256 calls |
| D11 | GUI-to-script calls never reach the API | Fixed, SPEC v0.4 (pulsaros#54, pulsaros-api#49) |
| D12 | Manifest shape mismatch | Fixed, SPEC v0.4: one schema |
| D13 | Syntax errors swallowed | Fixed, pulsarscript#11 |
| D14 | VM number formatting | Fixed |
| D15 | `arrayPush` and `arrayPop` do not change the variable | Decided, SPEC v0.2: value semantics; functions return new values |
| D16 | `&&` and `\|\|` broken | Fixed, pulsarscript#11 |
| D17 | Arrays and objects print as `<?>` | Fixed, SPEC v0.2 |
| D18 | Runtime error lines unreliable on the VM | Fixed, SPEC v0.4 (pulsarscript#15) |
| D19 | Exception unwinding broken | Fixed (pulsaros-api#47, pulsarscript#12) |

## Installable-app gaps (File Manager plan, 1–10)

All ten gaps are closed by the three open PRs and become closed on `master` and `main` when APP-01 completes.

| # | Gap | Closed in | Follow-up in this plan |
| --- | --- | --- | --- |
| 1 | An app's UI cannot ship in a bundle | Plan M0, M1, M5 | QA-02, APP-02 |
| 2 | "Install" installs nothing | Plan M1, M4 | QA-02 |
| 3 | Bundles are not stored or served | Plan M1, M4 | APP-07 (signatures) |
| 4 | Scripts cannot change files | Plan M3 | SEC-14 |
| 5 | Script storage lost on restart | Plan M3 | APP-06 (size quota) |
| 6 | Scripts cannot push to a window | Plan M3 | LANG-10 |
| 7 | The language lacks basics | Plan M2 (SPEC v0.5) | LANG-03 to LANG-08 |
| 8 | Capabilities per host call not built | Plan M3 | SEC-14 |
| 9 | Two package formats | Plan M0, M1 | Retire `fruit.manifest.json` (Doc 04) |
| 10 | No install consent | Plan M4, M5 | QA-02 |

## How this register is kept

1. A finding changes status only in the PR that changes the code, and that PR links the row.
2. A new finding gets the next free ID in its family and a backlog item, or an explicit "accepted" note with a reason.
3. "To verify" rows become Open or Closed the first time someone checks them; they do not stay.
4. The counts at the top are recomputed whenever a row changes.

# PulsarOS Development Plan — 01 · Findings and Defect Register

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

Every finding, defect and planned fix from the five project docs is listed here once, with its status on 23 November 2026 and the backlog item (Doc 08) and gate (Doc 00) that closes it. The project docs track these in four separate tables with overlapping ID letters; this register is the single list to update from now on.

**Status on 24 November 2026 (after the frontend branch):** still open are C3 (git history purge and password rotation), L4 (Svelte 5, planned), L5 (VM pin is an untagged commit), N11, and M9 as accepted. L25 is accepted. Everything else is fixed on the branches named in its row; none of those branches is merged.

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
| C4 | Stored XSS through messages | Critical | Fixed | Frontend | — (API HttpOnly session cookie + CSRF guard implemented in FE-13; frontend localStorage migration remains) | — |
| C5 | `dev-ecs` frontend does not build | Critical | Fixed | Frontend | — | — |
| H1 | App Store writes without a token: collections, asset upload and delete, download records | High | **Fixed** (auth + authz wired across collections, assets, analytics, category, search, publishers, appstore, apps, message threads, review deletes; route-table write guard in `cmd/server/route_guard_test.go`) | API | SEC-04, SEC-05 | G1 |
| H2 | App installs IDOR | High | Fixed | API | — | — |
| H3 | Deleted accounts still sign in and keep their tokens | High | **Fixed** (deleted and `acc.enabled: false` users rejected on login/token validation; `DeleteUser` revokes tokens atomically) | API | SEC-06 | G1 |
| H4 | Rate limits trust forwarded headers from anyone | High | **Fixed** (XFF/`X-Real-IP` ignored unless peer matches `TRUSTED_PROXIES`, IPv6-safe right-to-left XFF walk, `Limiter.Stop()`, per-username `AuthUserLimit`, `/v1/user/changepswd` & `/v1/token/validate` covered) | API | SEC-07 | G1 |
| H5 | No body limits outside the app routes; no quota check before writes | High | **Fixed** (`BodyLimit` middleware with prefix overrides returning `413`; per-user `maxFileSize` and storage quota enforced atomically in `filesystem` returning `413`/`507`) | API | SEC-08 | G1 |
| H6 | PocketBase superuser credentials reach browsers if `VITE_PB_ADMIN_*` is set | High | **Fixed** (reports go to `/v1/bug-reports`; the PocketBase client and its dependency are gone; CI greps the bundle) (pulsaros `feat/pulsaros-backlog`) | Frontend, API | FE-01 | G3 |
| H7 | Legacy unsalted SHA-256 passwords accepted forever | High | **Fixed** (constant-time legacy verification, transparent bcrypt upgrade on login, `PULSAROS_LEGACY_PASSWORD_CUTOFF`, and startup legacy count warning) | API | SEC-09 | G1 |
| H8 | No working CI | High | Fixed | All | — | — |
| H9 | Server timeouts: the 30 s write timeout cuts the PulsarIMS alert stream; no `ReadHeaderTimeout` | Medium (was High; re-rated by the analysis after the partial fix) | **Fixed** (`ReadHeaderTimeout: 10s`, `responseWriter.Unwrap()`, per-response `http.ResponseController.SetWriteDeadline(time.Time{})` on streaming/long-poll routes, `AlertHub.Broadcast` race fix, and `Manager.StopAll()` on shutdown) | API | OPS-05 | G2 |
| N1 | Scripts can allocate unbounded memory: 134 MB inside one RPC call's step budget | High | **Fixed** (uncatchable string/collection/heap/memory caps in VM & Interpreter, `vmrun` flags, `FuzzLoadModuleAndRun`; API wired to `pulsarscript/vm` v1.2 caps and per-VM mutex locking) | PulsarScript, API | LANG-01, LANG-02 | G0, G2 |
| N5 | Building arrays and objects is quadratic: whole-value copies on element updates cause ~7,000 object keys to blow the 1.5 s RPC time budget well inside the 250k step budget | High | **Fixed** (Conchon–Filliâtre CoW arrays/objects preserving D15 semantics: 20k appends 11.2 ms, 10k object keys 6.5 ms) | PulsarScript | LANG-17 | G4 |

## Medium

| ID | Finding | Status | Repo | Closed by | Gate |
| --- | --- | --- | --- | --- | --- |
| M1 | CORS preflights fail when `AUTH_CODE` is set | **Fixed** (`CORS` middleware wraps outside `AuthCode` and `RejectMisdirectedRequests`, and `AuthCode` allows `OPTIONS` and `X-Auth-Code` in `AllowedHeaders`) | API | OPS-03 | G2 |
| M2 | Message read and delete fail on Postgres (`= 1` on booleans) | **Fixed** (SQLite/Postgres booleans, `RETURNING id`, and `$1..$N` placeholders fixed across `message`, `publishers`, `search`, and `categories` with Postgres 15 parity tests) | API | OPS-02 | G2 |
| M3 | No migration runner; the server applies no schema | **Fixed** (embedded `migrations/` runner in `internal/database/migrate`, `pulsaros-api migrate` subcommands, dev auto-migrate, and non-dev `CheckVersion` startup gate) | API | OPS-01 | G2 |
| M4 | `RequireAdmin` can never pass; `POST /api/sites` is shadowed | **Fixed** (`RequireAdmin` switched to `authz.IsAdmin` and `POST /api/sites` registered directly on mux with JSON `Content-Type`) | API | SEC-02, SEC-11 | G0, G1 |
| M5 | Review routes match by substring, so a "helpful" vote creates a review | **Fixed** (migrated to Go 1.22 method+segment routes under canonical and legacy prefixes) | API | SEC-11 | G1 |
| M6 | `/v1/users/get` lists every user without a login | **Fixed** (GET-only active users, sanitized DB errors, and `acc` narrowed to `profilePicture`) | API | SEC-10 | G1 |
| M7 | IPC devices not bound to their owner | Fixed | API | — | — |
| M8 | FiveM servers share one key, compared with `!=` | **Fixed** (`FIVEM_SERVER_KEYS` per-server binding with constant-time compare, cross-server WiFi ownership enforcement, and Q9 feature flags) | API | SEC-12 | G1 |
| M9 | In-memory state blocks a second replica; grew with script VMs and the event hub | Open, accepted for now (single-replica deployment documented in OPS-06; multi-replica tracked in OPS-09) | API | OPS-06 (run one replica), OPS-09 (later) | G2 |
| M10 | Binds to localhost; Postgres TLS off by default | **Fixed** (`LISTEN_ADDR` with derived `LocalOnly` Host checking, deprecated `ARCOS_LISTEN_CONFIG_OVERRIDE` warning, and `DB_SSLMODE=require` default for non-local Postgres hosts) | API | OPS-04 | G2 |
| M11 | Tests stale or brittle | Fixed | API | — | — |
| M12 | Interpreter lags the compiler | Fixed | PulsarScript | — | — |
| M13 | Builds not reproducible | Fixed | All | — | — |
| M14 | Web Browser sends every URL to a third-party worker | **Fixed** (frame check removed) (pulsaros `feat/pulsaros-backlog`) | Frontend | FE-02 | G3 |
| M15 | 512 `svelte-check` errors and 76 ESLint suppressions, held at a baseline | **Fixed** (0 `svelte-check` errors, 0 ESLint suppressions; CI fails on any) (pulsaros `feat/pulsaros-backlog`) | Frontend | FE-11 | HT |
| N2 | `AUTH_CODE`: the server reads a header, the frontend sends `?ac=`, app windows can send neither | **Fixed** (`X-Auth-Code` to the connected server only; signed UI paths) (pulsaros `feat/pulsaros-backlog`) | API, frontend | OPS-03 | G2 |
| N3 | An installed app's window can navigate itself and carry out what it has read | **Fixed** (wrapper frame with `frame-src 'self'`, port revoked on navigation; QA-02 proves in Chromium and Firefox that no request leaves) (pulsaros `feat/pulsaros-backlog`) | Frontend, API | APP-02 | G3 |
| N4 | No browser end-to-end test in any repo | **Fixed** (`e2e/`: 10 tests in each browser against a live API; the CI job needs the secret `API_REPO_TOKEN`) (pulsaros `feat/pulsaros-backlog`) | All | QA-02, QA-04 | G3, HT |
| F13 | 17 UI library components do not compile; `TreeView` is broken | **Fixed** (broken components fixed or deleted) (pulsaros `feat/pulsaros-backlog`) | Frontend | FE-05 | G3 |
| — | Language gaps: string escapes, templates, closures, standard library, modules | **Fixed** (PulsarScript v1.0–v1.2 delivered; API event dispatch, lock-free suspend/resume, `script.service.event`, and G5 runtime exit checks wired; note pinned `pulsarscript/vm` `ContinueWithBudget` does not expose post-suspend RPC stack-top values) | PulsarScript, API | LANG-03 to LANG-13 | G4, G5 |
| N6 | Scripts cannot order strings (`"a" < "b"` errors) or delete object keys; nested index assignment rejects non-variable indices (`o.items[len(o.items)] = i`); `number("1e3")` vs `parseFloat`/literals mismatch | **Fixed** (code-point string ordering, `objDelete`/stdlib, arbitrary nested index keys, `/* */`, `?:`, hex/exp literals) | PulsarScript | LANG-18, LANG-09 | G4, G5 |
| N7 | Apps lack a scoped file picker or Open / Open with launch (forcing `fs.user` on Markdown Viewer), have no light/dark `scheme` in theme events, and cannot open URLs except via clipboard | **Fixed** (pickers, grants, Open with, launch, Settings → Apps, `scheme`, `os.openUrl`; Markdown Viewer 1.1.0 without `fs.user`) (pulsaros `feat/pulsaros-backlog`) | API, Frontend | APP-10, APP-09 | G3, G5 |
| N8 | No local mock-host `fruit dev` or `.pulsar` `fruit create` templates; window console logs go nowhere; apps lack shared layout CSS and a self-hosted icon font (Google Fonts blocked by CSP) | **Fixed** (Developer Console with script and window logs, SDK 1.1.0 UI kit) (pulsaros `feat/pulsaros-backlog`) | API, Frontend | APP-05, APP-11, DX-07, DX-06 | G3, G5, G6 |
| N9 | Installed apps could not run their script from a window: the IPC engine read `apps.app_id`, a column the migrated schema lacks (found by QA-02) | **Fixed** (`ipc.EngineConfig.InstalledScopes`; pulsaros-api `feat/pulsaros-frontend-integration`) | API | QA-02 | G3 |
| N10 | A dialog opened by an app appeared behind the app's own window (found by QA-02) | **Fixed** (`.subprocesses` no longer makes a stacking context) | Frontend | QA-02 | G3 |
| N11 | The signed app-UI token lives 15 minutes and is part of the page's base URL, so files an app loads later than that get 401 until it is reloaded | Open | API, frontend | — | G7 |

## Low

L6–L23 come from the audit of 22 November and were **not** re-checked on 23 November. The first step of each batch item is to confirm the bug still exists on the default branch.

| ID | Finding | Status | Repo | Closed by | Gate |
| --- | --- | --- | --- | --- | --- |
| L1 | Session tokens stored in plain text and never purged | **Fixed** (`sha256:`-prefixed token storage, idempotent startup migration, and UTC startup/hourly expiry purge) | API | SEC-13 | G1 |
| L2 | Generated files tracked: `coverage.html`, `sites.go.bak` | **Fixed** (`coverage.html`, `internal/handlers/sites.go.bak`, and generated sample/test directories removed) | API | REL-01 | G2 |
| L3 | Names mix FruitOS, ArcOS and PulsarOS (module path, binary, `/health`, environment variables) | **Fixed** (API and frontend user-visible names; internal app IDs kept) | API, frontend | REL-02 | HT |
| L4 | Svelte 4 and Vite 4 | Open; planned (FE-15 done: go, 5–7 d, `docs/svelte-5-migration.md`) | Frontend | FE-15 (plan and spike) | HT |
| L5 | The API pins an untagged VM commit (in #53) | Open | API | APP-01 | G0 |
| L6 | `PulsarMDT.authenticate()` always returns true and calls a `dispatch.send` that does not exist | **Fixed** (fails closed: there is no MDT login backend; FE-12) | Frontend | FE-12 | HT |
| L7 | `ensureSystemFoldersBootstrap` assigns an undeclared `bootstrapped` (never called) | **Fixed** (declared; FE-12) | Frontend | FE-12 | HT |
| L8 | Bug-report lookup reads `issueid`; the field is `issuedid` | **Fixed** (reads `issuedid`; FE-12) | Frontend | FE-12 | HT |
| L9 | Message-compose error path reads fields that `MessageSendResult` does not have | **Fixed** (was a type error only; FE-12) | Frontend | FE-12 | HT |
| L10 | `dependendsOn` typo in 8 manifests and the loader | **Fixed** (renamed in manifests, types and loader; FE-12) | Frontend | FE-12 | HT |
| L11 | FiveM `message` listener accepts `postMessage` from any origin | **Fixed** (own origin only; FE-12) | Frontend | FE-12 | HT |
| L12 | Message notifications render `{@html}` after stripping a few characters | **Fixed** (rendered as text; FE-12) | Frontend | FE-12 | HT |
| L13 | `AuthCode` compares with `!=` | **Fixed** (SHA-256 + `subtle.ConstantTimeCompare` via `ConstantTimeSecretEqual`) | API | SEC-12 | G1 |
| L14 | `GetMessage` dereferences sender and receiver without nil checks | **Fixed** (`formatUserIdent` nil/error guard across `GetMessage`, `ListMessages`, and `GetThread` with numeric ID fallback in `SEC-15`) | API | SEC-15 | HT |
| L15 | File moves build a `LIKE` pattern from user paths; `%` and `_` act as wildcards | **Fixed** (`escapeLikePrefix` + `ESCAPE '\'` across `removeItemDB`, `moveItemDB`, and `getItemSizeDB`, verified on SQLite & Postgres 15 in `SEC-15`) | API | SEC-15 | HT |
| L16 | `SafeJoin` rejects any name starting with `..`, such as `..notes` | **Fixed** (`escapesRoot` allows leading-`..` filenames like `..notes` while blocking `..` traversal segments on disk and DB backends in `SEC-15`) | API | SEC-15 | HT |
| L17 | Postgres DSN built with `fmt.Sprintf` | **Fixed** (`BuildPostgresDSN` constructs percent-encoded `postgres://` URIs via `net/url` and `net.JoinHostPort`) | API | OPS-04 | G2 |
| L18 | Script manifests load from `USERFILES_DIR/<appID>/`, the user-file tree, and scopes come from that file | **Fixed** (`scriptAppDirs` searches only `SCRIPT_APPS_DIR` and excludes `USERFILES_DIR` in `SEC-15`) | API | SEC-15 | HT |
| L19 | pulsarnetwork nonces and IDs use `math.random` | **Fixed** (`pulsarnetwork/shared/utils.lua` replaces `math.random` with `/dev/urandom`-backed `Utils.RandomBytes` + entropy-mixed fallback in `SEC-15`) | pulsarnetwork (Lua) | SEC-15 | HT |
| L20 | pulsaros `.gitmodules` lists 36 unregistered submodules; `CLAUDE.md` gives stale clone steps | **Fixed** (REL-01) | Frontend | REL-01 | G2 |
| L21 | `internal/config.Config` mostly unused; `cmd/server/setup.go` duplicates `main` | **Fixed** (`cmd/server/setup.go` removed in `SEC-04`; dead DB/RateLimit/FiveM fields pruned and active `Config` fields wired in `cmd/server/main.go` in `REL-01`) | API | SEC-04, REL-01 | G1, G2 |
| L22 | Unused frontend dependencies (`math.js`, `svelte-closable`); `serve` in runtime dependencies | **Fixed** (REL-01) | Frontend | REL-01 | G2 |
| L23 | About 20 AI-generated planning files in each repo root; other clutter (`sample.app`, `test-blank/`, `demo-reload-test/`, `matchcheck/`) | **Fixed** (REL-01) | API, frontend | REL-01 | G2 |
| L24 | App Store details modal renders empty screenshots, features, size, verified badge and long description, and reads legacy `script.exports.handlers` instead of `script.handlers` | **Fixed** (FE-16) | Frontend, API | FE-16 | G3 |
| L25 | Character-by-character string walk caps near 20,000 characters per RPC call; recursion stops at 256 calls deep | Accepted (by design, D10; mitigated by windowing, `LANG-09` string ops and `LANG-07`) | PulsarScript | — | — |

## Frontend hardening track (F1–F13)

| ID | Change | Priority | Status | Closed by | Gate |
| --- | --- | --- | --- | --- | --- |
| F1 | "Remember me" keeps a session token, not the password | P0 | Merged (pulsaros#58) | — | — |
| F2 | Password change: `POST` with `{old, new}`, old password verified, other sessions ended | P0 | Merged (pulsaros-api#52, pulsaros#58) | — | — |
| F3 | File names cannot inject markup through `DataTable` | P0 | Merged (pulsaros#59) | — | — |
| F4 | CSS injection through `{@html}` user style | P1 | Done (pulsaros `feat/pulsaros-backlog`) | FE-03 | G3 |
| F5 | One sanitizer; drop `style`; `rel` on new-tab links; audit other sinks | P1 | Done (pulsaros `feat/pulsaros-backlog`) | FE-04 | G3 |
| F6 | CI for pulsaros | P0 | Merged (pulsaros#57) | — | — |
| F7 | Search providers in parallel | P2 | Done (pulsaros `feat/pulsaros-backlog`) | FE-07 | HT |
| F8 | `closedPids` as a `Set` | P2 | Done (pulsaros `feat/pulsaros-backlog`) | FE-08 | HT |
| F9 | Immutable `ProcessHandler` updates | P3 | Done (pulsaros `feat/pulsaros-backlog`) | FE-06 | G7 |
| F10 | Modal accessibility | P2 | Done (pulsaros `feat/pulsaros-backlog`) | FE-09 | HT |
| F11 | Input accessibility | P2 | Done (pulsaros `feat/pulsaros-backlog`) | FE-10 | HT |
| F12 | Button forwards props; icon buttons get names | P3 | Done (pulsaros `feat/pulsaros-backlog`) | FE-06 | G7 |
| F13 | 17 components that do not compile | P2 | Done (pulsaros `feat/pulsaros-backlog`) | FE-05 | G3 |

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
| 4 | Scripts cannot change files | Plan M3 | **Done** (`SEC-14` API host-layer audit & `appfs.Copy` hardening) |
| 5 | Script storage lost on restart | Plan M3 | **Done** (`APP-06` per-app KV byte, VM count & CPU-per-minute quotas + telemetry) |
| 6 | Scripts cannot push to a window | Plan M3 | LANG-10 |
| 7 | The language lacks basics | Plan M2 (SPEC v0.5) | LANG-03 to LANG-08 |
| 8 | Capabilities per host call not built | Plan M3 | **Done** (`SEC-14` capability boundaries, prefix matching & process ownership) |
| 9 | Two package formats | Plan M0, M1 | Retire `fruit.manifest.json` (Doc 04) |
| 10 | No install consent | Plan M4, M5 | QA-02 |

## How this register is kept

1. A finding changes status only in the PR that changes the code, and that PR links the row.
2. A new finding gets the next free ID in its family and a backlog item, or an explicit "accepted" note with a reason.
3. "To verify" rows become Open or Closed the first time someone checks them; they do not stay.
4. The counts at the top are recomputed whenever a row changes.

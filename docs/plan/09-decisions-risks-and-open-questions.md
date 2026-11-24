# PulsarOS Development Plan — 09 · Decisions, Risks and Open Questions

23 Nov 2026 · Prepared for Berk Ormanlı · Status: **approved 23 Nov 2026**, with the recommended answers adopted

Eleven architecture decisions were already approved and nine of them are built. On 23 November the ten decisions this plan proposed (A12–A21) were approved, and the recommended answer was adopted for every open question that had one; later that day decisions A22–A26 were added after reconciling `pulsaros-api/openspec/` and empirical Markdown Viewer / PulsarScript probe findings. Two questions are still open: Q2 (second developer) had no recommendation, and Q5 (platform) has its constraints settled but needs a platform named. The risk register merges the two registers in the project docs and adds what the audit and the analysis imply. IDs refer to Doc 01 and Doc 08.

## Decisions already made (A1–A11)

| ID | Decision | Status on 23 Nov 2026 | What is left |
| --- | --- | --- | --- |
| A1 | The Go VM is the canonical runtime; the browser REPL and playground run it as WebAssembly | Implemented (`vm/cmd/vmwasm`, `site/pulsarvm.wasm`, Script Studio in `DX-04`) | `LANG-16` retires the TypeScript interpreter after one release (*Later*) |
| A2 | A written spec plus a conformance suite | Implemented: SPEC v0.4 and 122 cases on `main`; v0.5 and 159 in #18 | SPEC v1.0 at G4 |
| A3 | One host-API registry | Implemented as `hostapi.json` (the plan text said `.yaml`): 53 functions on `main`, 60 in #18 | Standard library entries (LANG-09) |
| A4 | Capabilities per host call | Approved; built in pulsaros-api#53, in review | Host-layer review (SEC-14) |
| A5 | Compile at build time; versioned bytecode header | Implemented: `{format, version, compiler, sourceHash}`; unknown versions refused; stale bundles refused | N and N−1 policy (LANG-15) |
| A6 | Stay small: no classes, prototypes, `this` or `throw` | Approved, holding | Closures and modules are inside the scope |
| A7 | The VM lives in pulsarscript as a Go module | Implemented; `vm/v0.4.0` released | Tag `vm/v0.5.0` (APP-01) |
| A8 | App UI is web code in a sandboxed iframe; PulsarScript is the server side | Approved; built in #53 and #60 | Real-browser proof (QA-02); navigation leak (APP-02) |
| A9 | One package format, `.pulsar` | Approved; built | Retire `fruit.manifest.json` and `.app` (Doc 04) |
| A10 | The API stores bundles by hash and serves UI files | Approved; built | Dedicated UI origin (A14) |
| A11 | Scopes approved at install, checked in the desktop and on the API | Approved; built | Quotas (APP-06) |

## Decisions approved on 23 November (A12–A21)

All ten were approved as recommended.

| ID | Decision | Approved | Alternative, and why not | Needed by | Progress |
| --- | --- | --- | --- | --- | --- |
| A12 | Where roles live | Server-owned `user_roles` and `publisher_members` tables behind one `authz` package; admin granted by command only; existing flags backfilled after review. Fixing C2 comes before the merge train | Keep roles in `properties` with a stricter filter: every filter so far has been bypassed (C2) | G0 | Implemented on master: pulsaros-api#54, #58 (closes C2) |
| A13 | How sessions are held | Tokens stored as hashes on the server (SEC-13); the browser session in an HttpOnly cookie with CSRF protection (FE-13); bearer header kept for tools | Stay in `localStorage`: any XSS hands over a live session | SEC-13 at G1; FE-13 in the health track | Not started |
| A14 | How app UIs are delivered | A dedicated hostname for app UIs; a wrapper frame whose CSP pins navigation; a short-lived token in the UI path when `AUTH_CODE` is set | Serve from the API origin and only detect navigation: the first request has already leaked (N3). Exempt UI files from `AUTH_CODE`: reveals which apps a protected server hosts | Spike in G3; token path in G2 | Not started |
| A15 | How schemas change | One migration runner with a tracking table; deployments run it as a step; the server refuses to serve on an old schema | Apply at server start in production: two instances starting together race, and a failed migration takes the service down | G2 | Not started |
| A16 | How the API is deployed | One container, one replica, Postgres with TLS, user files on persistent storage or in the database; platform chosen in Q5 | Scale out now: needs OPS-09 first, and nothing yet shows the need | G2 | Not started |
| A17 | How the standard library is named and built | Flat names matching the registry (`arrayMap`, `jsonParse`); functions that take functions written in PulsarScript as a prelude first | Namespaces such as `json.parse`: need module objects or compiler sugar; two styles in one language | Start of G5 | Not started |
| A18 | Memory is a budget | Per-mode caps on strings, collections and the VM total; exceeding one raises an uncatchable `MemoryLimit` | A catchable error: a script could catch it and keep allocating | G0 | Not started (LANG-01) |
| A19 | The App SDK is versioned | The SDK announces its version; the host negotiates; `fruit build` records it; unsupported majors are refused | One unversioned protocol: the first breaking change strands every installed app | G3 | Not started |
| A20 | Versioning across repos | Semantic versions in all three repos; a compatibility table; contracts bump as listed in Doc 07; the API never pins an untagged VM commit | Ad hoc: nothing says which frontend works with which API | G2 | Not started |
| A21 | When non-admins may publish | Only after the checklist in Doc 04: roles, memory limits, browser tests, navigation leak, host review, quotas, signatures | Open publishing with the installable-app merge: the sandbox is unproven in a browser | Before APP-07 | Holding: publishing stays admin-only |

## Decisions approved after Markdown Viewer and PulsarScript probe (A22–A26)

| ID | Decision | Approved | Alternative, and why not | Needed by | Progress |
| --- | --- | --- | --- | --- | --- |
| A22 | PulsarScript unplanned syntax | Pragmatic v1.0 subset in G4 (`LANG-18`): block comments `/* ... */`, ternary `?:`, and scientific/hex literals (`1e3`, `0x...`) unified with `parseFloat`/`number()`; `++`, `switch` and `do…while` stay excluded under A6 | Implement all six constructs (`++`, `switch`, `do…while`) or reject everything: misses common expressions and leaves literal/`number()` parity mismatched | G4 (`LANG-18`) | Approved 23 Nov |
| A23 | Quadratic collection updates | Split copy-on-write collection backing (preserving D15 value semantics) out of G7 `LANG-07` into G4 `LANG-17`, and pair with code-point string ordering and non-variable nested index expressions (`LANG-18`) | Leave `LANG-07` in G7: ~7,000 object keys blow the 1.5 s RPC time budget inside 250k steps, and scripts cannot sort file names | G4 (`LANG-17`, `LANG-18`) | Approved 23 Nov |
| A24 | Scoped file grants, pickers & file types | Live `grant:<handle>` paths resolved in `appfs` (`add-app-file-handles`), `dialog.openFile` supporting `multiple: true` (up to 50 files per pick in v1), `openFolder`, `saveFile`, manifest `fileTypes`, `Pulsar.info.launch`, and revoke UI in **Settings → Apps** | Copy files into `Inbox/` or add separate `handle` parameters; single-file pick only: piles up stale copies, churns `hostapi.json`, and makes multi-file picks awkward | G5 (`APP-09`, after `APP-03`) | Approved 23 Nov; OpenSpec `add-app-file-handles` updated |
| A25 | Theme `scheme`, `os.openUrl` & SDK UI kit | Send `scheme: "light"\|"dark"` in theme snapshots and add confirmed `Pulsar.os.openUrl` in G3 (`APP-10`, `add-app-sdk-theme-and-urls`); ship plain-CSS `pulsar-app-ui.css` + self-hosted Material Icons route `/v1/apps/sdk/v1/fonts/{file}` in G5 (`APP-11`, `add-app-sdk-ui-kit`); defer menus, shortcuts, context menus and window bounds (`APP-12`) to *Later* | Wait for `APP-11` or import Svelte/Google Fonts into iframes: Google Fonts fails iframe CSP (`connect-src 'none'`), and apps keep duplicating layout CSS | G3 (`APP-10`), G5 (`APP-11`), Later (`APP-12`) | Approved 23 Nov; OpenSpecs `add-app-sdk-theme-and-urls` & `add-app-sdk-ui-kit` drafted |
| A26 | Local app workbench & UI console | Replace legacy WebSocket/`devenv connect` `fruit dev` and `fruit.manifest.json` templates (`add-cli-dev-workflow`) with a loopback HTTP mock-host workbench (`DX-07`) backed by `appfs` and the in-process Go VM; extend `APP-05` with bounded iframe console forwarding (`update-fruit-dev-workbench`) | Keep `devenv connect` or `SCRIPT_APPS_DIR`-only dev flow: requires full server/DB setup just to test UI changes and leaves window `console.*` invisible | G3 (`APP-05`), G6 (`DX-07`, movable after G3) | Approved 23 Nov; OpenSpec `update-fruit-dev-workbench` drafted |

## Risk register

Likelihood and impact are this plan's judgement on a three-step scale.

| # | Risk | Likelihood | Impact | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | The API is exposed, or the app PRs merge, before C2 is closed | Medium | High | G0 order: SEC-01 the same day, SEC-02 before APP-01. Keep the API off the public internet until G1. #53 switched its upload check to `authz.IsAdmin` in #58 | Mitigated: SEC-01 (#54) & SEC-02 (#58) merged on master |
| R2 | Three large PRs merge together and break a default branch | Medium | Medium | Merge train with a check after each step and a one-merge revert (Doc 04) | Open |
| R3 | One developer reviews everything; 45 of the API's 63 non-merge commits came from a bot | High | Medium | Small PRs, required CI, the route-table test, gates with exit tests; a second developer (Q2) | Open |
| R4 | Closures take longer than 6 days (upvalue capture, interpreter parity) | Medium | Medium | Staged delivery in LANG-05; 1.0 can ship without capture; `registerHandler` by name keeps working | Carried over from the Development Plan |
| R5 | Untrusted scripts escape limits through host calls or memory | Medium | High | LANG-01, LANG-02 now; async budgets in LANG-11; SEC-14 review; APP-06 quotas | Carried over; N1 makes it concrete |
| R6 | The sandbox behaves differently in a real browser: CSP in an opaque origin, fonts and icons, `"null"` origins | Medium | High | QA-02 in Chromium and Firefox before anyone but admins publishes | Carried over from the File Manager plan |
| R7 | The navigation pin (A14) does not hold in one browser | Low to medium | Medium | Spike first; fall back to detection plus port revocation; publishing stays admin-only | New |
| R8 | A spec change breaks scripts already in bundles | Low | High | Versioned bytecode (A5); N and N−1 (LANG-15); stored old-version bundles in the loader tests | Carried over, largely mitigated |
| R9 | Memory caps set too low break File Manager Lite or legitimate apps | Medium | Low | Per-mode configuration; tune from traces; caps aligned with the Base64 file cap | New |
| R10 | The migration baseline is wrong on an existing database | Low | High | Back up first; dry-run on a copy; the runner only marks version 013, it re-applies nothing | New |
| R11 | Hashing tokens or moving to cookies signs everyone out | High | Low | Accept it; announce it; do each once | New |
| R12 | No deployment platform is chosen, and G2 stalls | Medium | Medium | Answer Q5 by the end of week 2; OPS-06 is platform-neutral and proceeds regardless | Open: Q5 still needs a platform named |
| R13 | Estimates are optimistic; the calendar ignores holidays, and weeks 5 and 6 fall in late December | High | Medium | 15% contingency in Doc 00; re-plan at each gate; the health day absorbs small overruns | New |
| R14 | The WebAssembly VM is 2–3 MB | High | Low | Load it only in Script Studio; look at TinyGo if size matters | Carried over |
| R15 | Publishers ship harmful apps | Low now | High | Admin-only publishing (real only after SEC-02); signatures and review before opening (A21) | Carried over |
| R16 | File Manager Lite grows toward parity with the built-in File Manager | Medium | Low | Feature list frozen at the M6 scope | Carried over |
| R17 | Apps look out of place because an iframe does not inherit the OS's CSS or icon font | Low | Low | The SDK sends theme variables plus light/dark `scheme` (`APP-10`) on open and change, and apps can opt into `pulsar-app-ui.css` + self-hosted Material Icons (`APP-11`); check it in QA-02 | Mitigating (`APP-10` in G3, `APP-11` in G5) |
| R18 | Long jobs exceed run budgets | Low | Medium | Cursor paging today; events and async host calls in G5; LANG-13 settles the pattern | Carried over, mitigated |
| R19 | Svelte 4 falls further behind while the baseline is burned down | Medium | Low | FE-15 produces a dated plan; no migration before FE-11 reaches zero | New |
| R20 | In-memory state is lost on every restart or deploy (VMs, IPC registry, events) | High | Low to medium | Graceful shutdown (OPS-05); clients reconnect; OPS-09 only if a second replica is needed | New, from M9 |
| R21 | The frontend writes a top-level properties key that SEC-01's allow-list does not include, and the setting is silently lost on save | Low | Low | The allow-list mirrors the frontend's `UserData` type; the server logs every dropped key by name; review the log after deploying #54 | New, from SEC-01 |
| R22 | A compromised app uses `Pulsar.os.openUrl` query parameters to leak data through the Web Browser | Low to medium | Medium | Strict `http:`/`https:` allowlist (max 2,048 chars), 5/min rate limit, and mandatory desktop prompt naming the app and showing the full URL/origin before opening (`APP-10`) | New, from `APP-10` |
| R23 | Copy-on-write backing in `LANG-17` accidentally shares mutations across variables or function calls | Medium | High | Dual-runtime conformance tests explicitly testing nested aliasing, loop captures, and parameter passing under D15 copy semantics | New, from `LANG-17` |

Retired: "moving the VM into the pulsarscript repo churns pulsaros-api" (done under A7), and "script calls are slow for interactive use" (settled by design: browsing goes through the SDK, scripts handle multi-file work).

## Questions

On 23 November the recommended answer was adopted for every question that had one.

| # | Question | Answer | Changes | Needed by | Status |
| --- | --- | --- | --- | --- | --- |
| Q1 | Will third-party developers write apps in the next six months? | Assume not yet | If yes, G7 (hardening) runs before G6 (tooling), and APP-07 joins the plan | Start of G4, week 9 | Answered; revisit at week 9 |
| Q2 | Is a second developer available? | — | About 12 weeks instead of 22: one on the API, platform and frontend, one on the language and tooling | Week 1 | **Open**: no recommendation to adopt. The plan runs on one developer until answered |
| Q3 | Does `fruit` stay in pulsaros-api or move next to the compiler? | Stay; decide again at the start of G6 | Where DX-01 and DX-02 are packaged | Start of G6 | Answered |
| Q4 | Purge the committed database and binary from git history? | Yes. Rotate the password regardless | A force-push and fresh clones | Week 1 | Answered. Untracked in pulsaros-api#55. The purge runs straight after the G0 merge train, because a force-push rewrites the base of every open PR (#53 included). Afterwards, ask GitHub Support to drop cached views and `refs/pull/*` objects |
| Q5 | Which platform runs staging and production? The old branch name suggests ECS; no artifacts exist | Any platform that runs one container with persistent storage and managed Postgres | OPS-07's details | End of week 2 | **Open**: constraints adopted; a platform still has to be named |
| Q6 | Does protected-server mode (`AUTH_CODE`) stay? | Yes, with the header for API calls and the token path for app UIs | If no, delete the mechanism and close M1 and N2 by removal | Week 3 | Answered |
| Q7 | Is a separate hostname available for app UIs? | Yes: one hostname for all apps in v1 | A14's design; without it, N3 stays an accepted risk | Start of G3, week 5 | Answered; the hostname itself is still to be picked |
| Q8 | Move the browser session to an HttpOnly cookie? | Yes | FE-13 stays in the health track | Week 8 | Answered |
| Q9 | Do PulsarIMS, FiveM and PulsarMDT ship in a public deployment? | Behind flags, off by default | Shrinks what G1 must harden; M8 and the stream part of H9 become optional | Week 2 | Answered |
| Q10 | When does the Svelte 5 migration happen? | After FE-11 reaches zero; FE-15 gives the estimate | Not in this plan's totals | After G5 | Answered |
| Q11 | What are the final names? | Module `github.com/PulsarDynamics/pulsaros-api`, binary `pulsaros-api`, environment prefix `PULSAROS_` with the old names accepted for one release | REL-02 | Before `v0.9.0`, week 5 | Answered; `PULSAROS_ENV` (#55) is the first variable to use the prefix |
| Q12 | May a deleted username be registered again? When must SHA-256 passwords be reset? | No reuse; reset 60 days after SEC-09 ships | SEC-06, SEC-09 | Week 2 | Answered |
| Q13 | Does File Manager Lite replace the built-in File Manager? | Decide after G3, with browser tests as evidence | Nothing before G3 | After G3 | Answered (deferred by design) |

Questions the project docs asked that are now settled: A1 and A6 are approved; A8 is approved; admins publish in v1; apps get a private folder with `fs.user` as a separate scope; dragging out of app windows is not in v1 (kept as APP-08, design only); `add-app-file-handles` open questions were settled on 23 Nov (multi-file pick supported in v1 via `multiple: true` up to 50 files; revoke list in Settings → Apps; Decision A24).

## Found while doing G0

- `user.Service.IsEnabled` is never called, so `acc.enabled` is not enforced anywhere: disabling an account does nothing. Fold it into SEC-06, alongside deleted accounts.
- PR #53 adds a third copy of the vulnerable admin check (`isAdmin` in `internal/handlers/apps/apps.go`). It must call `authz.IsAdmin` before or straight after merging.

## Decision log routine

1. A decision gets the next A number, a one-line recommendation and the alternative it beat.
2. It is recorded here and, when it changes the API's behaviour, as an OpenSpec change in pulsaros-api, as the installable-app runtime was.
3. Its status moves from proposed to approved to implemented, and the implementing PR links it.

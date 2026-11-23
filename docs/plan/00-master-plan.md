# PulsarOS Development Plan — 00 · Master Plan

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed, for approval

PulsarOS has a sound language and a newly built app platform sitting on an API that is not yet safe to expose. This plan takes the three repos from that state to a publicly deployable PulsarOS on which developers can ship installable apps, in **eight gates (G0–G7) plus a weekly health track: 122 developer-days, about 25 weeks for one developer or 13 for two**. The first two weeks are fixed: close the two critical findings, merge the three open PRs in order, then sweep the API's authentication. Everything after that can be reordered.

This is the entry point to a set of ten docs. It consolidates the five existing project docs, resolves where they disagree, and adds what none of them planned: the audit's remediation as scheduled work, a deployment path, a release routine and a ticket-level backlog.

## The plan set

| Doc | Title | Answers |
| --- | --- | --- |
| 00 | Master Plan (this doc) | What happens, in what order, by when |
| 01 | Findings and Defect Register | Every finding and defect, its status, and what closes it |
| 02 | API Security and Deployment | How C2, C3 and the auth and deployment findings are fixed (G0–G2) |
| 03 | PulsarScript Language and Runtime | Memory limits, Language 1.0, runtime and standard library (G0, G2, G4, G5, G7) |
| 04 | Installable App Platform | The merge train, real-browser proof, the navigation leak, publishing rules (G0, G3) |
| 05 | Frontend Hardening and Health | Security fixes, the type baseline, session storage (G3, G7, health track) |
| 06 | Developer Tooling and Docs | Formatter, linter, language server, Script Studio, debugger (G6) |
| 07 | Testing, CI and Release Engineering | Gates per milestone, coverage targets, versions, environments |
| 08 | Backlog | 78 items with estimates, dependencies and acceptance tests |
| 09 | Decisions, Risks and Open Questions | A1–A26, 23 risks, 13 questions |

The five existing docs stay as the dated record: the Audit Report (22–23 Nov), the Detailed Repository Analysis (23 Nov), the PulsarScript Development Plan (22 Nov), the File Manager plan (22–23 Nov) and the landing page (23 Nov). Where this set and an older doc disagree, this set is the newer reading.

## Where things stand on 23 November 2026

| | PulsarScript | PulsarOS API | PulsarOS frontend |
| --- | --- | --- | --- |
| Default branch | `main` at 6453537 | `master` at 2926fb3 | `main` at 29ac721 |
| Open PR | #18: SPEC v0.5, bytecode v2 | #53: installable apps | #60: window host, App SDK |
| Size after the PRs | 7,050 lines | 27,100 lines | 79,300 lines |
| Tests after the PRs | 159 conformance cases on 2 runtimes, 58 unit, 57 Go | 211 Go test functions, 26.5% statement coverage, 25 packages with none | 121 Vitest cases, no browser test |
| Health | `tsc`, `gofmt`, `go vet` clean | `gofmt`, `go vet` clean | 512 `svelte-check` errors and 76 ESLint suppressions at a baseline |
| Releases | `vm/v0.4.0` | none | none |
| Open findings | 1 high (N1) | 2 critical, 5 high, most of the mediums | 1 high (H6), several mediums |

**Done:** all 19 language defects (D1–D19); Phases 0 and 1 of the language roadmap; one line of work per repo; CI on every PR in all three; four of thirteen frontend hardening changes (F1–F3, F6); nine of the audit's 29 critical, high and medium findings. **Since the initial 23 Nov baseline:** the G0 installable-app PRs (`pulsarscript#18` + `vm/v0.5.0`, `pulsaros-api#53`, `pulsaros#60`), `SEC-01` (`#54`), `SEC-02` (`#58`, closing `C2`), `SEC-03` code (`#55`), and the Markdown Viewer example (`pulsaros-api#60`) merged, and `pulsaros-api/openspec/` was reconciled with the active proposals (`add-app-file-handles`, `add-app-sdk-theme-and-urls`, `add-app-sdk-ui-kit`, `update-fruit-dev-workbench`).

**Open:** 54 items in Doc 01: 1 critical, 8 high, 21 medium, 24 low (plus 1 accepted low, L25).

## Where the project docs disagree

Reading the five docs side by side turned up these conflicts and gaps. Each has a resolution that the rest of this set follows.

| # | Conflict or gap | Resolution |
| --- | --- | --- |
| 1 | The Development Plan (22 Nov) lists F1–F3 and F6 as "in review"; the landing page and analysis (23 Nov) say merged | Merged. Four of thirteen done |
| 2 | The Development Plan's Phase 1 checklist is mostly unticked, yet its text says "Phase 1 complete" | Phase 1 is complete; the checkboxes are stale |
| 3 | Decision A3 and Phase 5 say `hostapi.yaml`; the registry was built as `hostapi.json` | `hostapi.json` |
| 4 | Language figures differ between docs: bytecode v1, 42 opcodes, 53 functions, 122 cases against v2, 48, 60, 159 | Both are right: the first set is `main`, the second is #18. Every figure in this set names its branch |
| 5 | Test counts differ: the landing page says 75 TypeScript and 79 Go tests; the analysis says 57 and 52 for pulsarscript on `main` | Different scopes. This set uses the analysis's per-repo counts |
| 6 | The Development Plan says the API pins a commit "until `vm/v0.4.0` is tagged" | It is tagged and `master` uses it. #53 pins commit 0c17243 until `vm/v0.5.0` exists (L5) |
| 7 | Roadmap length is given as 19 weeks, "about 21 weeks", and 19 plus 5–6 more | All three describe the original scope at different dates. This plan re-baselines on remaining work: 108 days |
| 8 | "M" means two things: audit findings M1–M15 and File Manager plan milestones M0–M7 | This set writes "Plan M3" for milestones and uses G for its own gates |
| 9 | H9 is High in the audit and Medium in the analysis's open-items table | Medium, re-rated after its partial fix |
| 10 | The audit's roughly 20 low findings appear in no later doc; the analysis tracks only L1–L5 | Numbered L6–L23 in Doc 01 and scheduled. Not re-checked since 22 Nov, so each starts with verification |
| 11 | The analysis says to "migrate existing flags" when fixing C2 | Those flags are user-writable, so they cannot be trusted. The backfill is reviewed by hand (Doc 02) |
| 12 | Admin-only publishing is cited as the safeguard for untrusted publishers and for the navigation leak, while C2 lets anyone become admin | C2 closes before the installable-app PRs merge (G0) |
| 13 | Phase 3's exit test requires the reference script in RPC and service modes; the app work pages long jobs through RPC with a cursor instead | Settled in LANG-13, once events and async host calls exist |
| 14 | The landing page shows A4 as "Approved"; the analysis describes it as enforced on every host call | Built in #53; "implemented" once #53 merges |
| 15 | Of the Development Plan's four open questions, two are answered (A1, A6); the File Manager plan's five were answered by building with the recommended defaults, except whether a second developer is available | Remaining questions are consolidated in Doc 09 |
| 16 | The retired branch was named `dev-ecs`, but no doc plans deployment and no repo has a container or infrastructure file | Added: OPS-06 to OPS-08 |
| 17 | No doc plans releases for the API or frontend, or says which versions work together | Added: Doc 07 |
| 18 | The roadmap never estimated the audit's remediation; the analysis's recommendations give ranges but no schedule | Scheduled as G0–G2 and the health track |
| 19 | The diagrams in three docs were lost on export ("embedded content") | Redrawn as text: the gate sequence below, the app runtime in Doc 04 |
| 20 | Three incompatible `fruit dev` designs exist (`add-cli-dev-workflow` WS/`devenv connect`, Doc 06 `SCRIPT_APPS_DIR`, local mock host) | Local HTTP mock-host workbench (`DX-07`, OpenSpec `update-fruit-dev-workbench`, Decision A26); `add-cli-dev-workflow` marked superseded |
| 21 | `AppDetails.svelte` reads legacy `script.exports.handlers` instead of `.pulsar` `script.handlers`, and leaves screenshots/features/size/verified/long description blank | Fixed in `FE-16` (G3), closing `L24` |

## Goals

| Goal | Reached at | Proof |
| --- | --- | --- |
| The installable-app PRs can merge without handing publishing to any registered user | G0 | The C2 reproduction returns 403 for every variant |
| The API can face the public internet | G2 | The public-exposure checklist in Doc 02 |
| The app platform works in real browsers and does not leak | G3 | Playwright in Chromium and Firefox, required in CI |
| The language is pleasant enough for real app logic | G4, G5 | SPEC v1.0, 250 or more cases; the reference script runs in both modes |
| A new developer succeeds from the docs alone | G6 | The timed exit test in Doc 06 |
| Publishing can open beyond admins | G7 plus APP-07 | The checklist in Doc 04 |

**Not in this plan:** new built-in apps; the Svelte 5 migration itself (only its plan and spike); running more than one API replica; a redesign of the component library; classes, prototypes or `this` in the language (A6).

## Workstreams

| Prefix | Workstream | Items | Days | Detail |
| --- | --- | --- | --- | --- |
| SEC | API security | 15 | 11.5 | Doc 02 |
| OPS | Deployment and operations | 8 | 9.5 | Doc 02 |
| LANG | PulsarScript language and runtime | 17 | 36 | Doc 03 |
| APP | Installable-app platform | 9 | 17 | Doc 04 |
| FE | Frontend | 16 | 20.75 | Doc 05 |
| DX | Developer tooling | 7 | 18 | Doc 06 |
| QA | Testing and CI | 4 | 7.25 | Doc 07 |
| REL | Release and hygiene | 2 | 2 | Docs 02, 07 |
| | **Total** | **78** | **122** | Doc 08 |

Items that span two repos are counted once, under their prefix.

## Gates

Each gate ends on a test, not a date, as the Development Plan set out. Target weeks assume one developer starting Monday 23 November 2026, full time, with one day a week on the health track from week 3.

| Gate | Goal | Main contents | Exit test | Days | Target week |
| --- | --- | --- | --- | --- | --- |
| **G0** | Safe to merge | C2 (SEC-01, SEC-02), C3 (SEC-03), VM memory limits (LANG-01), the merge train (APP-01) | C2 reproduction fails for every variant; three default branches green; `hello.pulsar` installs | 4.5 | 1 · 23–27 Nov |
| **G1** | API auth sweep | H1, H3, H4, H5, H7, M5, M6, M8, hashed tokens, the route-table test | No write route answers without a token, proven by a test that walks the router | 5.5 | 2 · 30 Nov–4 Dec |
| **G2** | Deployable | Migrations, Postgres parity, CORS and access code, listening and TLS, timeouts, container, staging, observability, loader fuzzing, hygiene | A clean checkout deploys to staging on Postgres; the public-exposure checklist is complete | 11.75 | 5 · 21–25 Dec |
| **G3** | App platform proven | Playwright in two browsers, navigation leak, SDK versioning, contract checks, developer console (+ UI logs), theme `scheme` & `os.openUrl`, App Store details fix, H6, M14, F4, F5, F13 | The File Manager Lite scenario and sandbox assertions are required CI checks | 16 | 9 · 18–22 Jan |
| **G4** | Language 1.0 | String escapes, templates, closures, CoW collection updates, string ordering & pragmatic syntax, better errors, SPEC v1.0 | 280 or more cases on both runtimes; old bundles load; `v1.0.0` tagged | 16 | 13 · 15–19 Feb |
| **G5** | Runtime and standard library | Standard library, events, async host calls, modules, scoped file grants & pickers (`APP-09`), SDK UI kit & icon font (`APP-11`) | The reference script runs in RPC and service modes inside default budgets; Markdown Viewer runs without `fs.user` | 20 | 18 · 22–26 Mar |
| **G6** | Developer tooling | Formatter, linter, language server, Script Studio on WebAssembly, debugger, docs site, local mock-host `fruit dev` & `.pulsar` templates (`DX-07`) | A new developer ships a handler from the docs alone in under two hours | 18 | 23 · 26–30 Apr |
| **G7** | Hardening and performance | Compiler & VM loop/string performance, parser fuzzing, host-layer review, quotas, compatibility policy, F9, F12 | Every review finding fixed or decided; benchmarks beat the G4 baseline | 8.75 | 25 · 10–14 May |
| **HT** | Health track | Type baseline to zero, small-bug batches, App Store service tests, app smoke tests, session cookie, chunk splitting, rename, Svelte 5 plan | Zero type errors in loaded files; API coverage ratchet at 55% | 21.5 | weeks 3–25 |

## Sequence and critical path

```
Week 1   G0  SEC-01 ─► SEC-02 ─► APP-01 merge train (#18 ─► tag vm/v0.5.0 ─► #53 ─► #60)
             SEC-03    LANG-01
Week 2   G1  SEC-04 ─► SEC-05 route-table test ─► SEC-06 … SEC-13
Week 3+  G2  OPS-01 ─► OPS-02 ─► OPS-06 ─► OPS-07 staging        LANG-02 fuzz
             OPS-03, OPS-04, OPS-05, OPS-08 in between
         G3  QA-02 Playwright ─► APP-02 navigation leak ─► APP-05 console (+ UI logs)
             FE-01 … FE-05, FE-16, APP-03, APP-04, APP-10 in between
         G4  LANG-03 ─► LANG-04 ─► LANG-05 closures ─► LANG-06 ─► LANG-08 v1.0.0
             LANG-17 CoW, LANG-18 string ordering & syntax alongside
         G5  LANG-09 ─► LANG-10 ─► LANG-11 ─► LANG-13      LANG-12 modules
             APP-03 ─► APP-09 file handles & pickers      APP-11 SDK UI kit & icons
         G6  DX-01 ─► DX-02 ─► DX-03      DX-04 ─► DX-05      DX-06      DX-07 fruit dev
         G7  LANG-07, LANG-14, LANG-15      SEC-14, APP-06      FE-06
```

Three chains decide the end date:

1. **Security to merge to browser proof:** SEC-02 → APP-01 → QA-02 → APP-02. Nothing on the app platform is trustworthy until this chain is done.
2. **Language:** LANG-05 (closures) → LANG-09 and LANG-10 → LANG-13. Closures are the single largest item at 6 days and the one most likely to slip.
3. **Deployment:** OPS-01 → OPS-06 → OPS-07. It stalls if no platform is chosen (question Q5).

**What can move.** G4 to G7 can be reordered after G3. `DX-07` (local mock-host `fruit dev` + `.pulsar` templates) can be pulled ahead of G6 right after G3 if app UI iteration needs it. If third-party developers are expected soon, G7 goes before G6. If language features matter more than deployment, G4 can start while G2's staging work waits for a platform decision.

## Effort and calendar

| Scenario | Days | Weeks | Finishes | With 15% contingency |
| --- | --- | --- | --- | --- |
| One developer | 122 | 24.4 | Week 25, 10–14 May 2027 | Week 29, 7–11 Jun 2027 |
| Two developers | 68 and 54 (balanced: 63.5 and 58.5) | about 13 | Week 13, 15–19 Feb 2027 | Week 15, 1–5 Mar 2027 |

With two developers, one takes the API, platform and frontend (G0's API items, G1, G2, G3, `APP-09`, `APP-11`, the health track, the rest of G7: 68 days) and the other takes the language and tooling (LANG-01, LANG-02, G4, G5's language items, G6, the language half of G7: 54 days). Moving QA-03 and SEC-15 to the second developer evens the lanes at 63.5 and 58.5 days.

The calendar ignores holidays; weeks 5 and 6 fall in late December.

**Where the 122 days come from**

| Origin | Days | What |
| --- | --- | --- |
| Roadmap work still open | 63.25 | The rest of Phases 2 to 6, the remaining F changes, the browser test and developer console, memory limits and loader fuzzing |
| Audit and analysis findings the roadmap never estimated | 31.25 | G0's and G1's security work, deployment blockers, the merge train, the navigation leak, H6, M14, the type baseline, small-bug batches, App Store tests, hygiene and the rename |
| Added by the 23 Nov baseline plan | 13.5 | Container, staging and observability; SDK versioning and contract checks; app smoke tests; session cookie; chunk splitting; the Svelte 5 plan |
| Added by OpenSpec & probe findings (23 Nov) | 14.0 | CoW updates & string ordering/syntax (`LANG-17`, `LANG-18`, net `LANG-09`/`LANG-07`), scoped file grants & multi-file pickers (`APP-09`), `scheme` & `os.openUrl` (`APP-10`), SDK UI kit & fonts (`APP-11`), UI console (`APP-05`), `AppDetails` (`FE-16`), mock-host `fruit dev` (`DX-07`) |

By the project docs' own arithmetic about 10 weeks of roadmap work remained. This plan budgets 12.7 weeks for the same scope, mainly because closures are still entirely ahead and Phase 2's exit criteria carry real cost.

## Working rules

1. One item, one reviewable PR, linked to its backlog ID and, where it closes one, its finding in Doc 01.
2. A bug fix starts with a failing test. A language change starts as a spec diff plus conformance cases.
3. A new host call needs a registry entry, a conformance case and a capability. A new write route needs an entry in the route-table test.
4. Cross-repo changes merge language first, then API on a tag, then frontend (Doc 07).
5. A gate is met when its exit test passes in CI. The plan is re-read at every gate: estimates, order and Doc 01's counts.
6. The health day is spent in the order Doc 08 lists. It is the first thing to give when a gate overruns, and the first thing restored afterwards.

## The first ten working days

| Day | Work | Result |
| --- | --- | --- |
| Mon 23 Nov | SEC-01 stop-gap filter with case-variant tests; SEC-03 untrack the database and binary; rotate the owner's password; answer Q2 and Q4 | C2 no longer reproducible through the known variants; a fresh clone has no database |
| Tue 24 – Wed 25 Nov (morning) | SEC-02 roles tables, `authz` package, reviewed backfill | No role is read from `properties` |
| Wed 25 (afternoon) – Thu 26 Nov (morning) | LANG-01 memory limits | The doubling loop fails with `MemoryLimit` |
| Thu 26 (afternoon) – Fri 27 Nov (morning) | APP-01 merge train and smoke test | **G0.** `vm/v0.5.0` tagged; three default branches green |
| Fri 27 (afternoon) – Mon 30 Nov | SEC-04 App Store write routes; SEC-05 route-table test | CI fails on any open write route |
| Tue 1 Dec | SEC-06 deleted users; SEC-07 trusted proxies and per-username limit | H3 and H4 closed |
| Wed 2 Dec | SEC-08 body limits and quota | H5 closed |
| Thu 3 Dec | SEC-09 password re-hash; SEC-10 user list; SEC-11 route matching | H7, M5 and M6 closed |
| Fri 4 Dec | SEC-12 FiveM keys; SEC-13 hashed tokens; answer Q5, Q9 and Q12 | **G1.** Every high API finding closed |

G0 and G1 fill these two weeks with no slack, and reviewing the three open PRs sits inside APP-01's single day. If the reviews take longer, G1 runs into week 3 and nothing else changes order.

## Decisions needed

| When | Decision | Doc 09 |
| --- | --- | --- |
| Today | Approve the order: C2 before the merge train | A12 |
| Week 1 | Second developer or not; purge the database from git history or not | Q2, Q4 |
| Week 2 | Deployment platform; whether PulsarIMS, FiveM and PulsarMDT ship publicly; username reuse and the password reset date | Q5, Q9, Q12 |
| Week 3 | Whether protected-server mode stays | Q6 |
| Week 5 | A hostname for app UIs; final names | Q7, Q11 |
| Week 9 | Whether third-party developers are near, which decides G6 against G7 | Q1 |

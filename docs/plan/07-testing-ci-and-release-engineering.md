# PulsarOS Development Plan — 07 · Testing, CI and Release Engineering

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

Every repo now blocks a PR that breaks its build or tests; none blocks a PR that adds untested code, no repo runs a real browser, and the API and frontend have never had a release. This doc sets the CI gates each milestone adds, the test layers still missing, coverage targets, and a versioning and release routine for three repos that depend on each other. IDs refer to Doc 01 and Doc 08.

## CI today and at each gate

| Check | PulsarScript | API | Frontend | Added by |
| --- | --- | --- | --- | --- |
| Build and type check | `tsc`, Go build | Go build | `vite build` | in place |
| Unit and integration tests | Bun; Go with `-race` | Go, plus the Postgres migration test | Vitest | in place |
| Format and lint | `gofmt`, `go vet` | `gofmt`, `go vet` | ESLint and `svelte-check` baselines | in place |
| Conformance on both runtimes | yes | — | — | in place |
| End-to-end through real handlers | — | 2 tests on SQLite | — | in place (#53) |
| Route-table guard: no open write route | — | **new** | — | SEC-05, G1 |
| Race detector | yes | **new** | — | QA-01, G2 |
| Coverage ratchet | — | **new** | — | QA-01, G2 |
| Service tests on Postgres | — | **new** | — | OPS-02, G2 |
| Fuzzing, short on PRs and nightly | **new** (loader, then parser and compiler) | — | — | LANG-02, G2; LANG-14, G7 |
| Browser end-to-end, Chromium and Firefox | — | **new**, required | **new**, required | QA-02, G3 |
| Contract checks: registry, OpenSpec & manifest fixtures | **new** | **new** (`openspec validate --all --strict`) | **new** | APP-04, G3 |
| Built bundle holds no admin variable names | — | — | **new** | FE-01, G3 |
| Smoke test of all 41 apps | — | — | **new** | QA-04, HT |
| Benchmarks tracked nightly | **new** | — | — | LANG-08, G4 |
| Type and lint gate at zero for loaded files | — | — | **new** | FE-11, HT |

Branch protection on all three default branches: required checks, one review, no direct pushes. The API's CI needs the `PULSARSCRIPT_TOKEN` secret to fetch the private VM module; keep it scoped to read that one repo.

## Missing test layers

The analysis names five gaps. Each has an owner item.

| Gap | Risk it leaves | Item | Gate |
| --- | --- | --- | --- |
| No real browser anywhere | The app sandbox, its CSP and the `MessagePort` hand-over are proven only in jsdom | QA-02, QA-04 | G3, HT |
| App Store services untested: collections, assets, analytics, publishers, reviews, search, categories; `services/appstore` at 8% | H1's open routes live here | QA-03, SEC-05 | HT, G1 |
| The VM loader against hostile input | Uploaded bundles carry bytecode | LANG-02 | G2 |
| Postgres beyond migrations | SQLite-only SQL passes CI and fails in production (M2) | OPS-02 | G2 |
| Concurrency in the API | The VM manager, IPC registry and event hub are shared state | QA-01 | G2 |

## Coverage targets

Targets are for the ratchet, which only moves up. They are goals for planning, not measurements.

| Repo | Today | End of G3 | End of G7 |
| --- | --- | --- | --- |
| API statements | 26.5%; 25 packages with no tests | 40%; every App Store package has tests | 55%; no package that handles a request is at zero |
| PulsarScript conformance cases | 159 after #18 | 165 or more (memory limits) | 280 or more by G4, growing with every host call |
| Frontend unit cases | 121 after #60 | 140 or more | growth tied to FE-11's areas |
| Frontend browser tests | 0 | Main scenario plus sandbox assertions | plus all 41 apps |

Low-coverage modules outside the app platform (PulsarIMS 7%, FiveM 26%, v1 handlers 11%, v2 handlers 19%) are raised only where G1 touches them. Whether PulsarIMS and FiveM ship at all in a public deployment is question Q9 in Doc 09.

## The rules

These come from the Development Plan's testing strategy and now apply to all three repos.

1. A bug fix starts with a failing test. For the language, that test is a conformance case.
2. A new host call needs a registry entry, a conformance case and a capability before it merges.
3. A new HTTP write route needs an entry in the route-table test's expectations, which means someone decided who may call it.
4. A golden file changes only on purpose, and the diff is reviewed.
5. A finding in Doc 01 closes only in the PR that adds its regression test.
6. `xfail` is allowed only with a linked issue.

## Versions and releases

PulsarScript has one release (`vm/v0.4.0`). The API and the frontend have none, so nothing says which frontend works with which API.

| Repo | Scheme | First tags proposed |
| --- | --- | --- |
| PulsarScript | Semantic versions; `vm/vX.Y.Z` for the Go module at the same commit | `vm/v0.5.0` (G0), `v0.6.0` (G2), `v1.0.0` (G4), `v1.1.0` (G5) |
| API | Semantic versions; `/health` reports version, commit and the VM module version | `v0.9.0` at G2 (first deployable), `v0.10.0` at G3, `v1.0.0` when the public-exposure checklist in Doc 02 is complete |
| Frontend | Semantic versions; the build stamps version and commit into the About screen | Tagged with the API release it was tested against |

**Compatibility table.** One file in the frontend repo lists, for each frontend release, the lowest API version it works with. The Playwright job runs the frontend against that API version and against the API's default branch.

**Contracts that need a version bump when they change:**

| Contract | Bump |
| --- | --- |
| Bytecode format | Bytecode version; the VM keeps reading N and N−1 (LANG-15) |
| Host API registry | Minor version of PulsarScript for an addition; a removal follows the deprecation process |
| `AppManifest.json` schema | Additive changes only inside v1 (e.g. `fileTypes` in `APP-09`) |
| App SDK protocol | SDK version, negotiated at `app.ready` (APP-03; `1.1.0` adds `APP-09`/`APP-10`) |
| HTTP routes | Additive inside a major API version; the `{"data": …}` reply shape does not change |

## The cross-repo merge routine

The three open PRs are the first case; later language features that touch the API follow the same order.

1. Merge in pulsarscript and tag.
2. Update the API's `go.mod` to the tag (never to a bare commit; that is finding L5), then merge the API change.
3. Merge the frontend change.
4. The Playwright job on the frontend's default branch confirms the set works together.

## Environments

| Environment | Purpose | Data | From |
| --- | --- | --- | --- |
| Local | Development | SQLite, or Postgres through the compose file | OPS-06 |
| CI | Every PR | Fresh databases of both kinds | in place, extended by OPS-02 |
| Staging | Every merge to a default branch; the Playwright job can target it | Postgres with TLS; seeded test users; restored from backup once as a drill | OPS-07 |
| Production | Tagged releases only | Postgres with TLS; one API replica | After the public-exposure checklist |

## Landing page refresh

The landing page states figures "from the main branches" on 23 November. When APP-01 completes, these change:

| Figure on the page | Now | After the merge train |
| --- | --- | --- |
| Conformance cases | 122 / 122 | 159 / 159 |
| Functions in the registry | 53 (40 core, 13 host) | 60, of which 20 need a capability |
| Bytecode | v1, 42 opcodes | v2, 48 opcodes |
| VM release | `vm/v0.4.0` | `vm/v0.5.0` |
| SPEC | v0.4 | v0.5 |
| A4, capabilities per host call | Approved | Implemented |
| Installable apps | In review | Merged; browser test next |
| Roadmap length | "about 21 weeks" | Replace with the gates in Doc 00 |

The page's test counts (75 TypeScript unit tests, 79 Go tests) appear to be counted across repos and do not match the analysis's per-repo numbers (57 and 52 in pulsarscript on `main`). Say which repos each figure covers when updating.

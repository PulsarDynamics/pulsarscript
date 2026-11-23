# PulsarOS Development Plan — 06 · Developer Tooling and Docs

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

Today a PulsarScript developer has a compiler, a REPL, `vmrun` and a first-app guide, and nothing in the editor or the OS that helps while writing — and app UI authors have no local mock host or `.pulsar` template. Gate G6 (18 days, Phase 5 of the Development Plan plus `DX-07`) adds a formatter, a linter, a language server, an in-OS Script Studio on a WebAssembly build of the VM, a debugger, generated docs, and a local mock-host `fruit dev` workbench (`DX-07`, movable right after G3). It ends when a developer new to PulsarOS writes, tests and debugs a handler from the docs alone. IDs refer to Doc 08.

G6 starts after Language 1.0 (G4): tools written against a moving grammar get rewritten (`DX-07` depends only on G3 / `APP-01` and may move ahead of G6).

## What exists

| Tool | Where | Does |
| --- | --- | --- |
| Compiler (`compile.ts`) | pulsarscript | `.puls` to bytecode JSON with a version header, source hash and line map |
| REPL | pulsarscript | Runs on the TypeScript interpreter, with source-context error messages |
| `vmrun` | With the Go VM | Run, disassemble, step, inspect handlers; budget and seed flags |
| `fruit build`, `fruit publish` | pulsaros-api `cmd/fruit`, `internal/fruit/builder` | Compile `.puls`, pack `ui/`, write source hashes, validate, upload |
| `appbundle package`, `validate` | pulsaros-api `cmd/appbundle` | Write and check `.pulsar` packages |
| Registry | pulsarscript `vm/hostapi.json` | 60 typed functions with capabilities; already generates part of the spec |
| Guides | pulsaros-api (with #53) | "Build your first app", `docs/bundled_apps.md`, `docs/app_manifest.schema.json` |
| SDK types | pulsaros | `pulsaros-app-sdk.d.ts` |

## G6 items

| Item | Deliverable | Design notes | Days |
| --- | --- | --- | --- |
| DX-01 | Formatter, `fruit fmt` | Built on the existing parser, so it needs comments and blank lines kept in the syntax tree first. One style, no options. Test: formatting every conformance case twice gives the same text, and the formatted case still produces its expected output | 2 |
| DX-02 | Linter, `fruit lint` | Rules from the Development Plan: unused variables, shadowing, unknown host calls, and a host call whose capability the app's manifest does not request. The last rule reads `AppManifest.json` next to the source, and catches at build time what would otherwise be a `PermissionError` at run time | 2 |
| DX-03 | Language server and VS Code extension | Diagnostics from the parser, analyzer and linter; completion and hover text generated from `hostapi.json`; go-to-definition inside a file, and across files once modules exist (LANG-12). The extension also registers the `.puls` file type and a manifest schema for `AppManifest.json` | 4 |
| DX-04 | WebAssembly VM and Script Studio | Build the Go VM with `GOOS=js GOARCH=wasm`. Script Studio is a PulsarOS app with an editor, output, a disassembly view and live budget meters for steps, time and memory. The Development Plan expects a 2–3 MB binary, so it loads only when Script Studio opens. Host calls that need the server (`fs*`, `kv*`) run against in-memory stand-ins and are labelled as such. This delivers decision A1 | 4 |
| DX-05 | Debugger | Breakpoints by line, step in, over and out, and a view of locals and globals, built on the line maps and on `vmrun`'s step mode. Budgets pause while stopped at a breakpoint | 2 |
| DX-06 | Docs site | Generated on every release from `SPEC.md`, the registry and the conformance cases, so every example on the site is a test that passes. Includes the SDK reference, the manifest reference and a refreshed first-app guide without the newline workaround | 1 |
| DX-07 | Local mock-host `fruit dev` workbench & `.pulsar` `fruit create` templates | Replaces the legacy WebSocket/`devenv connect` `fruit dev` and `fruit.manifest.json` templates (`add-cli-dev-workflow`) as well as the earlier `SCRIPT_APPS_DIR` sketch. Serves `ui/` inside `<iframe sandbox="allow-scripts">` with production CSP, theme switcher (`light`/`dark`), scope toggles, mock pickers, local file root via `internal/apps/appfs`, in-process Go VM with default RPC budgets, live console drawer, and `fsnotify` recompile/reload (OpenSpec `update-fruit-dev-workbench`, Decision **A26**) | 3 |

## The exit test

"A new developer can write, test and debug a handler from the docs alone" is checked the same way each time:

1. Someone who has not written PulsarScript gets the docs site URL and a task: an app with one handler that lists a folder and returns the three largest files.
2. They may use Script Studio, the VS Code extension and `fruit`. They may not ask questions.
3. Pass: an installed, working app in under two hours. Every point where they got stuck becomes a docs or tooling issue.

## The `fruit` command line

The Development Plan left open whether `fruit` lives in pulsaros-api or moves next to the compiler. Recommendation: **leave it in pulsaros-api for now and decide at the start of G6.** Its packaging and validation code is shared with the server's upload path, and that sharing is what keeps "what `fruit` accepts" equal to "what the store accepts". The new `fmt` and `lint` subcommands are thin wrappers that call into pulsarscript. This is question Q3 in Doc 09.

| Command | State | Does |
| --- | --- | --- |
| `fruit create` | `DX-07` (replacing legacy templates) | Scaffold `.pulsar` `blank` and `starter` projects |
| `fruit build` | Built (#53) | Compile, pack, hash, validate; links modules after LANG-12 |
| `fruit publish` | Built (#53) | Upload a version |
| `fruit fmt` | DX-01 | Format sources |
| `fruit lint` | DX-02 | Lint sources against the manifest |
| `fruit dev` | `DX-07` (OpenSpec `update-fruit-dev-workbench`) | Local HTTP mock-host workbench for `ui/` + in-process VM + `appfs` fake tree + live reload |
| `fruit test` | Proposed, not estimated | Run an app's handlers against fixtures on the local VM |

## Order and overlap

DX-01 and DX-02 come first because the language server reuses both. DX-04 can run in parallel with DX-03 when a second developer is available: one works in the pulsarscript repo, the other mostly in the frontend. `DX-07` can run immediately after G3 if app UI iteration needs it without waiting for G6. With one developer the order is DX-01, DX-02, DX-03, DX-04, DX-05, DX-06, DX-07.

If third-party developers are expected soon, the hardening gate G7 runs before G6; tooling waits, safety does not (question Q1 in Doc 09).

## Docs that stay hand-written

| Doc | Home | Updated when |
| --- | --- | --- |
| `SPEC.md` | pulsarscript | Every language change, before the code |
| `docs/bundled_apps.md`, `docs/bundled_apps_security_review.md` | pulsaros-api | Every change to the SDK protocol, the gateway or the sandbox |
| `docs/app_manifest.schema.json` | pulsaros-api | Every manifest change, with fixtures (APP-04) |
| Configuration reference | pulsaros-api | Every new environment variable (OPS-06) |
| This plan set | The PulsarOS project | At each gate |

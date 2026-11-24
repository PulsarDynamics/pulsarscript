# CLAUDE.md

PulsarScript is PulsarOS's scripting language: a TypeScript compiler and interpreter (run with
Bun) and a Go VM in `vm/`, which the PulsarOS API imports as the module
`github.com/PulsarDynamics/pulsarscript/vm`. The language is defined by `SPEC.md`; the host
functions scripts may call are listed in `vm/hostapi.json`.

## Development plan

The plan for this repo and the two others (pulsaros-api, pulsaros) is in `docs/plan/`. Start
with `docs/plan/README.md`. This repo's work is in `docs/plan/03-pulsarscript-language-and-runtime.md`
(the LANG items), and every item's estimate, dependencies and acceptance test is in
`docs/plan/08-backlog.md`.

- Work in gate order (G0, then G1, …), unless `docs/plan/00-master-plan.md` says an item can move.
- One backlog item per PR, titled with its ID (for example `LANG-01`).
- When a PR closes a finding (such as N1), update its row in `docs/plan/01-findings-and-defect-register.md`
  in the same PR, and copy the changed plan file to the other two repos.
- Decisions and open questions are in `docs/plan/09-decisions-risks-and-open-questions.md`. Don't
  reopen an approved decision without saying so in the PR.

## Rules for language changes

1. A language change starts as a `SPEC.md` diff plus conformance cases.
2. A bug fix starts with a failing conformance case.
3. A new host call needs an entry in `vm/hostapi.json`, a conformance case and a capability.
4. A bytecode change bumps the bytecode version and adds an old-version loader test.
5. Conformance must pass on both runtimes (TypeScript interpreter and Go VM).

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck                           # tsc --noEmit (root + VS Code ext via editors/vscode/tsconfig.json)
bun run build:wasm                          # build site/pulsarvm.wasm + site/wasm_exec.js (DX-04)
bun run gen:site                            # generate site/site-data.js, site/docs-data.js, site/pulsar-runtime.js (DX-06)
bun test                                    # TypeScript unit, contracts, formatter, linter, LSP, debugger, WASM & docs tests
bun run conformance -- --require-vm --require-wasm   # conformance suite across interp, Go VM, and WASM VM
bun run fmt -- --check <files...>           # PulsarScript formatter (DX-01)
bun run lint <files...>                     # PulsarScript linter + AppManifest scope checks (DX-02)
bun run lsp                                 # PulsarScript Language Server over stdio (DX-03)
bun run fuzz:compiler -- --iterations 5000  # Lexer/Parser/Semantic/BytecodeCompiler fuzzer (LANG-14)

cd vm
gofmt -l .                                  # must print nothing
go vet ./...
GOOS=js GOARCH=wasm go vet ./cmd/vmwasm
go test -race ./...
go test -fuzz=FuzzLoadModuleAndRun -fuzztime=5s .
go run ./cmd/vmrun -debug <bundle.json>     # Interactive breakpoint & step debugger (DX-05)
```

CI (`.github/workflows/ci.yml`) runs PR checks, `.github/workflows/nightly.yml` runs nightly compiler + Go VM fuzzing and benchmarks, and `.github/workflows/wasm-release.yml` automatically tags (`wasm/vX.Y.Z`) and publishes pre-built WASM assets as GitHub Releases when WASM-impacting files land on `main`. Generated docs live at `site/docs.html` (source tutorial: `docs/first-app-guide.md`).

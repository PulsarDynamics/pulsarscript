# Pulsar Vault

**Pulsar Vault** is a self-contained PulsarOS `.pulsar`-format **Notes, Tasks & Snippets Workspace** designed to exercise the full PulsarScript v1.2 language, standard library, and host runtime capabilities inside PulsarOS RPC (`250,000` steps / `1.5s`) and Service budgets.

## Bundle Layout

```text
examples/apps/pulsar-vault/
├── AppManifest.json        # PulsarOS app manifest (id, ui window, 11 RPC + 1 service handler, scopes)
├── icon.svg                # App icon referenced by AppManifest.json
├── host.ts                 # Standalone PulsarOS host bridge (virtual FS, KV, Base64, events, RPC budgets)
├── server.ts               # Local Bun HTTP + SSE dev server (`bun run app:vault`)
├── scripts/
│   ├── format.puls         # Escapes, nested templates, task parser, UTF-8 Base64 encoder, Digest formatter
│   ├── index.puls          # CoW tag index builder/pruner, closure matchers/comparators, math telemetry
│   ├── storage.puls        # Atomic fsWrite/fsRename, KV objMerge/objDelete, try/catch JSON quarantine
│   ├── main.puls           # Entrypoint linking modules, RPC handlers, and on("fs.change") service watcher
│   └── main.json           # Compiled PulsarScript bytecode bundle + multi-file source map
└── ui/
    ├── index.html          # Accessible single-page workspace with native <dialog> modals & light/dark theme
    ├── app.css             # Layered PulsarOS dark-slate/emerald styling with 0px horizontal mobile overflow
    ├── app.js              # Dual-mode UI (PulsarOS postMessage SDK when embedded, HTTP+SSE locally)
    └── pulsar-logo.png     # PulsarOS icon asset
```

## Run Locally

```bash
# 1. Recompile the multi-file PulsarScript bundle + source map
bun run build:vault

# 2. Launch the standalone local mock host on http://localhost:4174/
bun run app:vault
```

## PulsarScript v1.2 Feature Coverage

| Area | Implemented In | How It Is Exercised |
| --- | --- | --- |
| Modules (`import`/`export`) | [main.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/main.puls), [format.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/format.puls), [index.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/index.puls), [storage.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/storage.puls) | Multi-file linking via `compile.ts -s` producing a 10,838-entry source map across all 4 `.puls` files |
| Escapes & Unicode | [format.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/format.puls) | Astral `\u{1F512}`, `\u{2728}`, `\n`, `\r`, `\t`, `\"`, `\\`, and Unicode code-point indexing |
| Template literals & Ternary | [format.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/format.puls), [main.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/main.puls) | Nested `${...}` digest templates and conditional ternary formatting |
| Closures & Higher-Order Calls | [index.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/index.puls), [storage.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/storage.puls) | Stateful ID generator (`makeIdGenerator`), filter predicates (`makeNoteMatcher`), `<`/`>` title comparators (`makeNoteComparator`) |
| CoW Arrays & Objects (D15) | [index.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/index.puls), [storage.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/storage.puls) | Linear bucket appends, `objSet`, `objMerge`, and `objDelete` tag-bucket pruning |
| Strings, Math, Time & Random | [format.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/format.puls), [index.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/index.puls) | `split`, `replace`, `indexOf` with offset, `lastIndexOf`, `padStart`/`padEnd`, `repeat`, `charCodeAt`/`fromCharCode`, `<` / `>`, `log10`, `exp`, `sin`/`cos`/`tan`/`atan2`, `clamp`, `sqrt`, `dateFormat`, `randomSeed`/`randomInt` |
| Error Recovery (`try/catch`) | [storage.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/storage.puls) | Quarantines malformed JSON files (`_corrupt_sample.json`) with source-mapped multi-file `e.stack` without failing valid notes |
| Host FS, KV, Base64 & Events | [storage.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/storage.puls), [main.puls](file:///Users/berkormanli/Desktop/gitlab-repos/pulsarscript/examples/apps/pulsar-vault/scripts/main.puls) | `fsMkdir`, `fsExists`, `fsList`, `fsRead`, `fsWrite`, `fsRename`, `fsCopy`, `fsStat`, `fsQuota`, `fsWriteBase64`/`fsReadBase64`, `kvGet`/`kvSet`/`kvDelete`, `emit`, `notifyWindow`, `on("fs.change", ...)` |

## Verification

- TypeScript runtime & HTTP E2E tests: `tests/unit/vault-app.test.ts` (`bun test`)
- Go VM (`RPCVMConfig` & `ServiceVMConfig`) E2E tests: `vm/vault_app_test.go` (`go test -count=1 -race ./...`)

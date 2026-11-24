# PulsarScript VS Code Extension

Language support for PulsarScript (`.puls` / `.poo`) and `AppManifest.json` bundles:

- **Diagnostics**: live syntax, semantic, unused-variable, shadowing, unknown host call, and `AppManifest.json` capability checks.
- **Completion & Hover**: all 97 typed functions from `vm/hostapi.json`, keywords, and in-scope symbols.
- **Go to Definition**: same-file declarations and cross-file `import { ... } from "./..."` module symbols.
- **Formatting**: `fruit fmt` canonical formatting via `lsp/server.ts`.
- **Manifest Schema**: JSON Schema validation for `AppManifest.json` (`schemas/app-manifest.schema.json`).

## Usage

Open any PulsarScript workspace in VS Code (`bun` on `PATH`), or configure `pulsarscript.serverCommand` in settings.

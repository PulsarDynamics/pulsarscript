# Build Your First PulsarOS App: Disk Peek

This guide walks you from zero to a tested, formatted, linted, and debugged PulsarOS app using **PulsarScript v1.2** (`SPEC.md` v1.0, Bytecode v3).

By the end, you will have **Disk Peek** (`com.example.disk-peek`): a multi-module app with an RPC handler `largestFiles(dir)` that lists a directory via `fsList`, filters out subfolders, sorts files descending by byte size, keeps the top three, and formats a multi-line summary with native `\n` string escapes.

---

## 1. Project Layout

Create a directory `disk-peek/` with the following structure:

```text
disk-peek/
├── AppManifest.json
├── scripts/
│   ├── format.puls
│   └── main.puls
└── ui/
    └── index.html
```

---

## 2. Declare the Manifest (`AppManifest.json`)

Every PulsarOS app starts with `AppManifest.json` validated against `contracts/app_manifest.schema.json`. Declare the `"largestFiles"` RPC handler under `script.handlers` and request only the minimum capability scope (`"fs.read"`):

```json
{
  "id": "com.example.disk-peek",
  "name": "Disk Peek",
  "version": "1.0.0",
  "description": "List a folder and return the 3 largest files.",
  "author": "PulsarOS Developer",
  "sdkVersion": "1.0.0",
  "ui": {
    "entry": "ui/index.html",
    "window": {
      "width": 720,
      "height": 480,
      "minWidth": 420,
      "minHeight": 300,
      "resizable": true
    }
  },
  "script": {
    "bundle": "scripts/main.json",
    "source": "scripts/main.puls",
    "handlers": [
      {
        "name": "largestFiles",
        "mode": "rpc",
        "description": "Return up to three largest files in a folder"
      }
    ]
  },
  "permissions": {
    "scopes": ["fs.read"]
  }
}
```

> [!TIP]
> If your script ever calls a `fs.write`, `kv`, `events`, `window`, or `ipc` function without listing its scope in `permissions.scopes`, the PulsarScript linter catches it at build time before the VM raises a runtime permission error.

---

## 3. Write a Helper Module (`scripts/format.puls`)

PulsarScript supports standard backslash escapes inside string literals (`\n`, `\t`, `\r`, `\\`, `\"`, `\'`, `\u{...}`) natively—no workaround helpers are needed to produce newlines.

```puls
// scripts/format.puls

export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  var kib = round((bytes / 1024) * 10) / 10;
  return `${kib} KiB`;
}

export function formatSummary(dir, items) {
  if (len(items) == 0) {
    return `No files found in ${dir}`;
  }
  var lines = arrayMap(items, function(item) {
    return `- ${item.name} (${formatBytes(item.size)})`;
  });
  return `Top files in ${dir}:\n${arrayJoin(lines, "\n")}`;
}
```

---

## 4. Write the App Script (`scripts/main.puls`)

Import `formatSummary` using a relative `./` module specifier, filter directory entries (`!entry.dir`), sort descending with `arraySort(files, cmp)`, slice the top 3 with `arraySlice`, and register the RPC handler:

```puls
// scripts/main.puls
import { formatSummary } from "./format.puls";

export function findLargestFiles(dir) {
  var entries = fsList(dir);
  var files = arrayFilter(entries, function(entry) {
    return !entry.dir;
  });
  var sorted = arraySort(files, function(a, b) {
    return b.size - a.size;
  });
  var count = min(3, len(sorted));
  var top = arraySlice(sorted, 0, count);
  return {
    dir: dir,
    count: len(top),
    files: top,
    summary: formatSummary(dir, top)
  };
}

registerHandler("largestFiles", function(dir) {
  return findLargestFiles(dir);
});
```

---

## 5. Wire the UI (`ui/index.html`)

In your app window, invoke the registered RPC handler through the PulsarOS App SDK (`Pulsar.script.call`):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Disk Peek</title>
</head>
<body>
  <main>
    <h1>Disk Peek</h1>
    <label for="dirInput">Folder</label>
    <input id="dirInput" value="/docs">
    <button id="scanBtn" type="button">Find Largest Files</button>
    <pre id="summaryOut">Ready.</pre>
  </main>
  <script>
    document.getElementById("scanBtn").addEventListener("click", async function () {
      var dir = document.getElementById("dirInput").value || "/docs";
      var result = await window.Pulsar.script.call("largestFiles", [dir]);
      document.getElementById("summaryOut").textContent = result.summary;
    });
  </script>
</body>
</html>
```

---

## 6. Format, Lint, and Compile

Run the PulsarScript developer tools from your repo root before testing on the VM:

1. **Format** both script files consistently in one canonical style:

   ```bash
   bun run fmt disk-peek/scripts/format.puls disk-peek/scripts/main.puls
   ```

   Pass `--check` in CI to verify formatting without modifying files.

2. **Lint** against `AppManifest.json` to catch unused variables, shadowing, unknown host APIs, and missing capability scopes:

   ```bash
   bun run lint disk-peek/scripts/main.puls
   ```

3. **Compile** to Bytecode v3 JSON (`-g` emits local variable names into debug metadata so step debuggers can label stack frames cleanly):

   ```bash
   bun run compile -- -g -s disk-peek/scripts/main.puls disk-peek/scripts/main.json
   ```

4. **Inspect** the compiled bytecode and registered handlers with `vmrun`:

   ```bash
   cd vm && go run ./cmd/vmrun -inspect ../disk-peek/scripts/main.json
   ```

---

## 7. Test & Debug Interactively

### Option A: Browser Script Studio (Go VM on WebAssembly)

1. Open the interactive **Script Studio** (`bun run site` -> `#playground`), enable **`fs.read`** in Sandbox Capabilities, paste `formatBytes`, `formatSummary`, and `findLargestFiles`, and call `print findLargestFiles("/docs").summary;`.
2. Notice the **Engine: Go VM · WebAssembly** and **In-Memory Mock Host** badges. The mock filesystem seeds `/docs/notes.md`, `/docs/spec.md`, and `/docs/todo.txt`, so `fsList("/docs")` works out of the box without a backend server.
3. Click in the gutter or set a breakpoint line (for example the `var sorted = ...` line), then click **Debug**.
4. Use **Step Over**, **Step In**, and **Step Out** to follow execution into `formatSummary` while inspecting **Locals**, **Globals**, and **Call Stack**. While stopped at a breakpoint, the wall-time budget badge shows **Paused** so thinking time never eats your millisecond quota.

### Option B: CLI Debugger (`vmrun -debug`)

For local terminal debugging on compiled `.json` modules:

```bash
cd vm && go run ./cmd/vmrun -debug -cap fs.read ../disk-peek/scripts/main.json
```

Inside the `-debug` prompt, use `break <line>`, `continue`, `next` (step over), `step` (step in), `out` (step out), `locals`, `globals`, `stack`, and `quit`.

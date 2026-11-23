# PulsarOS Development Plan — 04 · Installable App Platform

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

The installable-app platform is built and merged across the default branches (plus the Markdown Viewer example in `pulsaros-api#60`), but it has never run in a real browser and one data-leak path is open. This doc covers completing the merge train (`L5` VM tag pin), proving the platform in Chromium and Firefox, closing the leak, adding theme scheme/`os.openUrl`/App Store details fixes (**16 days** in G3 including frontend security fixes), scoped file grants and SDK UI kit in G5 (**5.5 days**), and what must be true before anyone but an admin may publish. IDs refer to Doc 01 and Doc 08.

## What was built

All eight milestones of the File Manager plan are implemented across three PRs (merged on 23 Nov, followed by Markdown Viewer in `pulsaros-api#60`):

| PR | Contents | Plan milestones |
| --- | --- | --- |
| pulsarscript#18 | Language core, SPEC v0.5, bytecode v2, 159 conformance cases | M2 |
| pulsaros-api#53 | Package validation and content-addressed storage, publishing, consent, the gateway for files and storage, scripts that run as the user with checked scopes, window events, `fruit build` and `fruit publish`, File Manager Lite, the security review and a first-app guide | M0, M1, M3, M4, M6, M7 |
| pulsaros#60 | Window host, App SDK 1.0.0, App Store consent; the App Store client rewritten | M1, M5 |

Decisions A8–A11 are approved and built: a web UI in a sandboxed iframe with PulsarScript as the server side (A8), one `.pulsar` format (A9), bundles stored and served by the API (A10), and scopes checked in the desktop and again on the API (A11). The open questions were answered with the recommended defaults: admins publish in v1; an app gets a private folder by default and `fs.user` is a separate scope; dragging out of app windows is not in v1.

Two things differ from the plan as written: long script jobs page through RPC calls with a cursor instead of running as services (revisited in LANG-13), and the M6 "browser test" is an API-level end-to-end test plus jsdom tests. No real browser has run this code.

## How an installed app runs

The File Manager plan's diagram was lost when the doc was exported; this is the same flow in text.

```
 Browser                                                    PulsarOS API
┌──────────────────────────────────────────────┐          ┌────────────────────────────────────┐
│ PulsarOS desktop (Svelte)                    │          │ /v1/apps/{appId}/{version}/ui/…    │
│  ┌────────────────────────┐   MessagePort    │  HTTPS   │   static UI, strict CSP,           │
│  │ App window             │◄────────────────►│◄────────►│   connect-src 'none'               │
│  │ <iframe sandbox=       │  window host:    │          │ Gateway: app ID + installed scopes │
│  │   "allow-scripts">     │  checks scope,   │          │   ├─ app files (scoped root)       │
│  │ ui/index.html + SDK    │  message shape,  │          │   ├─ key-value store (per user)    │
│  │ opaque origin          │  rate            │          │   ├─ window events                 │
│  └────────────────────────┘                  │          │   └─ script runtime manager        │
└──────────────────────────────────────────────┘          │        └─ Go VM: budgets, host     │
                                                          │           calls checked per scope  │
                                                          └────────────────────────────────────┘
```

The app's own code runs only inside the iframe and inside the VM. The iframe cannot read the desktop's storage or session token, and has no network access of its own. It sends one `app.ready` to the host, receives a `MessagePort`, and every later request is checked twice: by the window host in the browser and by the gateway on the API.

## G0 — The merge train (APP-01)

C2 must be closed first (SEC-01, SEC-02): #53 uses the admin check to decide who may publish, and that check can be bypassed today.

| Step | Action | Check before moving on |
| --- | --- | --- |
| 1 | Merge pulsarscript#18 | CI green on `main`: type check, unit tests, conformance on both runtimes, Go tests |
| 2 | Tag `vm/v0.5.0` on the merge commit | `go list -m` resolves the tag from a clean module cache |
| 3 | In #53, replace the pin on commit `0c17243` with `vm/v0.5.0`; rebase onto `master` with the C2 fix; point the upload check at `authz.IsAdmin` | CI green, including the two end-to-end tests |
| 4 | Merge pulsaros-api#53; apply migration 013 to a copy of the working database | `hello.pulsar` uploads, installs and answers its `echo` handler |
| 5 | Merge pulsaros#60 | The App Store installs File Manager Lite against `master`; it opens from the Start menu |
| 6 | Update the landing page figures (Doc 07 has the list) | Page matches the default branches |

Merging #60 before #53 leaves the frontend calling routes that do not exist; installs would fail. If step 4 or 5 breaks staging, revert that one merge. The tag in step 2 stays.

## G3 — Proven in a real browser

### QA-02: Playwright against a live server (N4)

One CI job starts the API with a fresh database, serves the built frontend, and drives Chromium and Firefox.

- **Main scenario** (the File Manager plan's M6 exit test): sign in, open the App Store, read the consent dialog, install File Manager Lite, browse, create a folder, upload, rename, copy, move, delete, run a batch rename, update from 1.0.0 to 1.0.1, uninstall, and confirm the app and its storage are gone.
- **Sandbox assertions**, each a separate test with a hostile test bundle: the iframe cannot read the parent's `localStorage` or DOM; `fetch` and image loads to another host are blocked by the CSP; a bundle with no scopes is refused on every protected SDK call; a second `app.ready` is ignored; a message from a frame that is not the app's window is ignored; fonts and icons from the bundle load.
- The job is required on PRs to pulsaros and pulsaros-api.

### APP-02: stop the navigation leak (N3)

An app window can set its own `location` to another site and put what it has read in the URL. The desktop notices and stops the app afterwards, but that first request has already left. Admin-only publishing limits this today.

The analysis's next step is to serve app UIs from a separate origin. The proposed design, to prove in a spike of up to one day before building the rest:

1. App UIs are served from a dedicated hostname, not from the API's.
2. The app window becomes two frames. The outer one is a tiny page from that hostname whose Content Security Policy allows frames only from itself (`frame-src 'self'`). The inner one is the sandboxed app. The CSP specification applies a parent's `frame-src` to every navigation of its child frame, so the app should no longer be able to navigate itself anywhere else; the spike confirms that Chromium and Firefox both enforce it. The desktop page cannot carry this policy itself, because the Web Browser app must frame arbitrary sites.
3. The window host revokes the app's `MessagePort` on any navigation of the inner frame, so a reloaded page starts with nothing.
4. The Playwright suite gains a test in both browsers: a bundle that sets `location.href` to another host is blocked, and receives no data afterwards.

If the spike shows a browser does not enforce step 2 as expected, the fallback is detection plus revocation (step 3), and N3 stays a recorded risk that keeps publishing admin-only. The M7 review file (`docs/bundled_apps_security_review.md` in the API) is updated either way.

### APP-03: a versioned SDK

Each app carries its own copy of the SDK file, and nothing checks that copy against the desktop.

- The SDK sends its version in `app.ready`; the host replies with the protocol versions it supports.
- `fruit build` writes the SDK version into the manifest; package validation warns when it is older than the server's current one and refuses an unsupported major version.
- The host keeps answering the previous major version for one release cycle.

### APP-04: contracts checked by machines

The analysis lists six contracts between the repos. Two get new checks: every entry in `vm/hostapi.json` must have an implementation, or an explicit "not on this host" marker, in the API's script host; and one set of manifest fixtures (valid and invalid) is validated by the frontend, `fruit build` and the server loader.

### APP-05: developer console

The last Phase 4 item from the Development Plan, expanded for app UI logs (**N8**). A built-in app, visible to developers and admins, that shows per-app script logs, the list of live VMs with their budgets, each error with its `.puls` source line and a snippet from the line map, and bounded UI window `console.*` / uncaught error logs forwarded over `MessagePort` (`update-fruit-dev-workbench` OpenSpec change). The admin operations it needs already exist on the IPC side.

### APP-10: theme light/dark scheme and confirmed external links (`os.openUrl`)

Small SDK and host fixes identified while building Markdown Viewer (**N7**, OpenSpec `add-app-sdk-theme-and-urls`, Decision **A25**):

- `themeSnapshot` computes and sends `scheme: "light" | "dark"` alongside `name` and `vars`; the SDK applies `color-scheme` and `data-pulsar-scheme` to `<html>`, replacing `color-scheme: dark light` in `pulsar-app-sdk.css` so native controls match light themes.
- `Pulsar.os.openUrl(url)` lets apps ask the desktop to open `http:`/`https:` URLs (up to 2,048 chars, rate-limited at 5/min) in `WebBrowserApp`, always showing a confirmation dialog naming the app and displaying the full URL/origin before opening.

### FE-16: App Store page metadata and script handlers

Fixes **L24** in `AppDetails.svelte` and `src/apps/AppStore/ts/api.ts`: populate long description, bundle size, last updated timestamp, screenshots, and verified badge, and read `script.handlers` instead of the legacy `script.exports.handlers` field.

## Publishing beyond admins

Today only admins can publish. Opening publishing to registered publishers, or to third parties, waits for every row below.

| Requirement | Item | Gate |
| --- | --- | --- |
| Roles and publisher membership cannot be self-assigned | SEC-02 | G0 |
| Scripts cannot exhaust memory; the bytecode loader is fuzzed | LANG-01, LANG-02 | G0, G2 |
| The platform is tested in real browsers | QA-02 | G3 |
| The navigation leak is closed, or accepted in writing with a reason | APP-02 | G3 |
| The host layer has had its security review | SEC-14 | G7 |
| Per-app quotas and telemetry exist | APP-06 | G7 |
| Bundles are signed and the signature is checked at install | APP-07 | Later |

If third-party developers are expected soon, G7 moves ahead of G6 (question Q1 in Doc 09).

## Retiring the old formats

| Legacy | State today | Proposal |
| --- | --- | --- |
| `.poo` source files | Compile with a deprecation warning | Rejected from `v1.0.0` (G4) |
| `.app` packages | Read with a warning | Rejected by `fruit` and the API from the first release after G3 |
| `fruit.manifest.json` | Read with a warning | Removed in the same release |
| `SCRIPT_APPS_DIR` | Local development only | Stays, documented as a development option |
| FileManagerPro and WifiScannerPro as built-in apps with scripts | Work, compiled into PulsarOS | Keep as they are. Rebuilding them as `.pulsar` bundles is optional work after G3 |

## After G3

### G5 platform capabilities (after SDK versioning in APP-03)

- **Scoped file grants, pickers and file types (`APP-09`, G5, OpenSpec `add-app-file-handles`, Decision `A24`):** lets an app open user-chosen files or folders via `Pulsar.dialog.openFile` (including `multiple: true`, up to 50 files per pick in v1), `openFolder` and `saveFile`, and receive files launched via Open / Open with (`fileTypes` in `AppManifest.json`, `Pulsar.info.launch`), backed by `grant:<handle>` paths enforced in `appfs` and revocable in **Settings → Apps**. Markdown Viewer 1.1.0 drops `fs.user`.
- **Shared SDK UI primitives and self-hosted icon font (`APP-11`, G5, OpenSpec `add-app-sdk-ui-kit`, Decision `A25`):** opt-in plain-CSS `pulsar-app-ui.css` (toolbars, sidebars, lists, segmented controls, status bars, empty states) and self-hosted Material Icons Round `.woff2` + `pulsar-icons.css` served from `/v1/apps/sdk/v1/fonts/{file}` under the iframe CSP (no external Google Fonts request).

### Later

- **Quotas (APP-06, G7):** CPU time per minute, live VM count and key-value size per app and user, with dashboards built on the OPS-08 counters.
- **Signatures and wider publishing (APP-07, later):** sign bundles at `fruit publish`, verify at install, and store the result in the existing `manifest_signature` column.
- **Dragging out of an app window (APP-08, later):** design only, if users ask.
- **Desktop integration for complex apps (APP-12, later):** app menu bar declarations, keyboard shortcuts, context menus, and persisted window position/size (`Decision A25`).
- **File Manager Lite:** its feature list stays frozen at the M6 scope. Whether it replaces the built-in File Manager is decided after G3, with the browser tests as evidence.

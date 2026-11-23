# PulsarOS Development Plan — 05 · Frontend Hardening and Health

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

The frontend is the largest codebase and the least verified: about 79,300 lines, 121 unit tests after pulsaros#60, no browser test, and 512 type errors held at a baseline. This doc plans three things: the security and App Store fixes that share gate G3 with the app platform (4.5 days), the remaining hardening changes in G7 (1.25 days), and a health track of about one day a week that brings the type baseline to zero and moves the session out of `localStorage` (16 frontend days of the 21.5-day track). IDs refer to Doc 01 and Doc 08.

## Where the frontend stands

| | On `main` | After pulsaros#60 |
| --- | --- | --- |
| Stack | Svelte 4, Vite 4, TypeScript 5.4 | same |
| Apps | 41 built in | plus installed `.pulsar` apps, added to the library at sign-in |
| Unit tests | 70 Vitest cases | 121, concentrated in `src/ts/bundled`, sessions, sanitizing and scripts |
| Type and lint | 512 `svelte-check` errors, 76 ESLint suppressions in 41 files; CI blocks any increase | same |
| Build | passes; one 1.1 MB main chunk (321 kB gzipped) | same |
| UI library | 77 components in `src/lib/Components`; 17 do not compile | same; the App Store client is rewritten |
| CI | unit tests, build, lint and type baselines (pulsaros#57) | same |

Four of the thirteen hardening changes are merged: F1 ("Remember me" keeps a token, lasting as long as the API's `SESSION_LIFETIME`, one hour by default), F2 (password change), F3 (file-name markup) and F6 (CI). The Development Plan of 22 November still lists them as in review; the landing page and the analysis of 23 November record them as merged.

## G3 — Security and App Store fixes (4.5 days)

| Item | Finding | Change | Test |
| --- | --- | --- | --- |
| FE-01 | H6 | The bug reporter stops signing in to PocketBase as a superuser. Reports go to a new API endpoint that files them server-side; the report host becomes configuration instead of the hard-coded `pocketbase.berkormanli.com`. Until this merges, the rule is: no build sets `VITE_PB_ADMIN_EMAIL` or `VITE_PB_ADMIN_PASSWORD` | A CI step greps the built bundle for both names and fails if either appears |
| FE-02 | M14 | `checkIfLoadable` stops posting every URL to `ifc.izaak-kuipers.workers.dev`. Recommended: drop the check and show the browser's own frame error; the alternative is an API endpoint that performs the check | No request to that host in the Playwright run |
| FE-03 | F4 | Shell writes user CSS into a `<style>` element's `textContent` instead of `{@html}` | `</style><img onerror=…>` in user CSS creates no element |
| FE-04 | F5 | Merge `src/ts/sanitizer.ts`, `src/ts/util/sanitizer.ts` and `SafeHtml.svelte` into one module; drop the `style` attribute; add `rel="noopener noreferrer"` to `target="_blank"` links; review every remaining `{@html}` (SettingsOption, Wizard, Boot) | One import path for sanitizing; a unit test per sink |
| FE-05 | F13 | Fix or delete the 17 components that do not compile: dynamic `class:` directives in 14, JSX in `Chip`, a bad attribute in `TimelineItem`, optional chaining on the left of an assignment in `TreeView`. Most are unused, so delete first. Make the shared `Button` forward `on:click`; pulsaros#60 found that the App Store's buttons never fired because of it | Every file in `src/lib/Components` parses; the ESLint ignore list loses those entries |
| FE-16 | L24 | Populate App Store details fields (`longDescription`, bundle size, updated timestamp, screenshots, verified badge) from `AppResponse`, and read `.pulsar` `script.handlers` instead of legacy `script.exports.handlers` in `AppDetails.svelte` | Details modal renders screenshots, features, size, verified badge, long description and installed `.pulsar` handlers |

FE-03 and FE-04 matter more once themes or app content can be shared between users: today F4 is self-inflicted only.

## G7 — Remaining hardening (1.25 days)

FE-06 makes `ProcessHandler` update its `Map` immutably and removes the Map-to-Array copies in templates and loops, including ScriptServices (F9), and makes `Button` forward `$$restProps` with a `title` and `aria-label` on icon-only buttons (F12).

## Health track — about one day a week

In this order, starting in week 3.

| Item | What | Why now |
| --- | --- | --- |
| FE-12 | Seven small bugs from the audit's low list (L6–L12): `PulsarMDT.authenticate()` always true, the undeclared `bootstrapped`, `issueid` against `issuedid`, compose-error fields that do not exist, the `dependendsOn` typo, the FiveM `postMessage` listener that accepts any origin, and message notifications built with `{@html}`. Confirm each still exists on `main` first | Cheap, and L11 matters because the Web Browser frames arbitrary sites |
| QA-04 | Playwright opens each of the 41 built-in apps and fails on any uncaught error | Nothing tests any app's screen today |
| FE-07 | Search runs its providers with `Promise.allSettled` (F7) | A slow file search holds up every result |
| FE-08 | `closedPids` becomes a `Set` that forgets finished processes (F8) | It grows for the whole session |
| FE-09, FE-10 | Modal and Input accessibility (F10, F11) | Small, and every app inherits them |
| FE-11 | Burn down the type and lint baselines | See below |
| FE-13 | Session in an HttpOnly cookie | See below |
| FE-14 | Split the main chunk | See below |
| FE-15 | Svelte 5 and Vite: plan and spike | See below |

The API-side health items (SEC-15, QA-03) and the rename (REL-02) share this track; Docs 02 and 07 describe them.

### FE-11: type and lint baselines to zero (M15)

CI already stops the numbers from rising. This item brings them down.

| Checkpoint | `svelte-check` errors | ESLint suppressions |
| --- | --- | --- |
| Today | 512 | 76 |
| After FE-05 (broken components deleted or fixed) | measure; most errors sit in the generated library | measure |
| End of G5 | under 150 | under 25 |
| End of G7 | 0 in files the app loads | 0 |

Work by area, one PR each, lowering the stored baseline in the same PR: the component library, then stores and services, then apps in order of use. When the count for loaded files reaches zero, the CI gate for those files changes from "no increase" to "zero".

### FE-13: the session leaves `localStorage`

The session token is readable by any script on the page, so one XSS hands over a live session; the audit named an HttpOnly cookie as the long-term fix for C4. The change spans both repos.

- The API sets the session as an `HttpOnly`, `Secure`, `SameSite` cookie at login and accepts it next to the existing bearer header, which stays for tools and for one release of overlap.
- Cookie authentication needs CSRF protection on every write route: a required custom header that a cross-site form cannot send, checked against the CORS allow-list from OPS-03.
- The frontend stops reading or writing the token; the 38 `localStorage` call sites are reviewed, and the ones that only store preferences stay.
- App windows are unaffected: they never hold a token, and the window host makes their calls.

This depends on SEC-13 (hashed tokens) and OPS-03 (CORS order). It is decision A13 in Doc 09.

### FE-14: load apps when they open

All 41 apps are imported eagerly into one 1.1 MB chunk, which is also why one broken component once broke the whole build. Each app's component becomes a dynamic import, loaded on first open. QA-04 lands first so that a lazy-loading mistake is caught by a test.

### FE-15: Svelte 5 and Vite

Svelte 4 and Vite 4 both have newer major versions, and the audit found 56 components already written in Svelte 5 syntax on the old `dev-ecs` branch. This item produces a written migration plan and a spike on one app, ending in a go or no-go with an estimate. The migration itself is not in this plan's totals, and it should not start before FE-11 reaches zero: migrating code that does not type-check hides new errors among old ones.

## Tests the frontend gains

| Layer | Today | Added | Item |
| --- | --- | --- | --- |
| Unit (Vitest) | 121 cases after #60 | Sanitizer sinks, Modal and Input attributes, search, process bookkeeping | FE-04, FE-07 to FE-10 |
| Browser, app platform | none | Install, use and uninstall File Manager Lite; sandbox assertions | QA-02 |
| Browser, built-in apps | none | Open all 41 apps | QA-04 |
| Bundle checks | none | No admin variable names in the build; initial JavaScript size budget | FE-01, FE-14 |

## What stays out

- A redesign of the component library. Broken components are fixed or deleted, not rewritten.
- New built-in apps, until G3 is met.
- The Svelte 5 migration itself.

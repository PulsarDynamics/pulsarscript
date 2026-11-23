# PulsarOS Development Plan — 02 · API Security and Deployment

23 Nov 2026 · Prepared for Berk Ormanlı · Status: proposed

The API is the only thing between PulsarOS and a public deployment: both open criticals, five of the seven open highs and eleven of the eighteen open mediums are here. This doc turns each into a design and a test, in three gates: **G0** closes the criticals before the installable-app PRs merge (2.5 API days of its 4.5), **G1** sweeps authentication (5.5 days), and **G2** makes the API deployable (11.75 days). IDs refer to Doc 01 (findings) and Doc 08 (backlog).

Schemas, variable names and limits below are proposals to settle in review. File paths and route names are the ones the audit and the analysis recorded.

## G0 — Close the criticals

### SEC-01 and SEC-02: roles the user cannot write (C2, M4)

**Problem.** Admin rights and publisher membership are read from `acc.admin` and `appstore.publishers` in the user's own `properties` JSON, which three endpoints let the user write. `protectSensitiveProperties` strips the lowercase keys only, and Go's `encoding/json` matches keys case-insensitively, so `{"Acc":{"Admin":true}}` is stored and read back as admin. Once #53 merges, the same check decides who may publish `.pulsar` apps.

**Step 1, stop-gap (SEC-01, half a day).** One function filters properties on all three write paths: `POST /v1/user/properties/update`, `PUT /v2/users/me` and `POST /v2/users`.

- Compare keys after Unicode case folding at every nesting level, not just the top one.
- Reject a payload in which two sibling keys fold to the same name, instead of guessing which one wins.
- Keep an allow-list of top-level keys the frontend really writes (taken from its user-data type), and inside `acc` strip `admin`.
- Regression tests cover `acc.admin`, `Acc.Admin`, `ACC.ADMIN`, the same for `appstore.publishers`, and folded variants such as `appſtore` (long s), since Go's matching folds those too.

**Step 2, the real fix (SEC-02, one and a half days).** Roles move to tables that no user endpoint writes.

```sql
-- Sketch; names and types follow the existing schema.
CREATE TABLE user_roles (
  user_id    INTEGER   NOT NULL REFERENCES users(id),
  role       TEXT      NOT NULL,          -- 'admin' in v1
  granted_by INTEGER   REFERENCES users(id),
  granted_at TIMESTAMP NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE TABLE publisher_members (
  publisher_id INTEGER   NOT NULL REFERENCES publishers(id),
  user_id      INTEGER   NOT NULL REFERENCES users(id),
  role         TEXT      NOT NULL,        -- 'owner' | 'maintainer'
  added_by     INTEGER   REFERENCES users(id),
  added_at     TIMESTAMP NOT NULL,
  PRIMARY KEY (publisher_id, user_id)
);
```

- One `authz` package exposes `IsAdmin(ctx, userID)` and `CanManagePublisher(ctx, userID, publisherID)`. `checkAdminAccess` (publishers), `canManagePublisher` (appstore), `isAdmin`, the #53 upload check and `RequireAdmin` all call it. `RequireAdmin` stops reading the never-filled `Permissions` field, which closes M4.
- Admin is granted by a server-side command (`pulsaros-api admin grant <username>`) or a first-start bootstrap variable. No HTTP endpoint grants admin in v1. Every grant writes an audit row.
- **Backfill is reviewed, not automatic.** The analysis suggests migrating the existing flags, but those flags are exactly what any user could write, so they cannot be trusted. The migration exports every user whose properties contain a folded variant of either key; the owner confirms the list; grants are made by command; then the keys are deleted from all stored properties.
- With `RequireAdmin` working, decide what sits behind it: the legacy `/v1/filesystem/*` routes can now be reached by admins, or deleted, since `/v1/fs/*` covers the same need per user (the audit's preferred fix for C1).

**Exit test.** The audit's reproduction returns 403 for every variant; a granted admin gets 201; `grep` finds no read of a role from `properties`.

### SEC-03: no shipped database (C3)

1. `git rm --cached data/*.db data/*.sqlite bin/`, and add all three patterns to `.gitignore`.
2. The server exits at start when `DB_NAME` is unset outside development, with a message naming the variable.
3. A start-up check logs a warning if a `test` user with the known SHA-256 hash exists.
4. The owner changes the `berkormanli` password everywhere it is reused. This does not wait for the PR.
5. Decision: purge the files from history with `git filter-repo`, or accept that the hash stays readable to anyone with repo access. A purge needs a force-push and fresh clones, so it is cheapest now, while one person works on the repo.

## G1 — Authentication sweep

One PR per row, in this order. SEC-05 goes in right after SEC-04, so the guard test protects the rest of the sweep.

| Item | Finding | Change | Test |
| --- | --- | --- | --- |
| SEC-04 | H1 | Wrap collection create, edit and delete, asset upload and delete, and download-record writes in `RequireAuth` plus `authz.CanManagePublisher` or `IsAdmin`. Move these inline closures out of `main.go` into handler packages while touching them | 401 without a token, 403 for a non-member, 2xx for a member |
| SEC-05 | H1 | A test builds the real router, walks every route, and sends each non-GET request without a token. Anything that is not 401 or 403 must appear on a short public list (login, token, signup, health) that lives next to the test | Adding an open write route fails CI |
| SEC-06 | H3 | `GetUserByUsername` and `ValidateToken` filter `is_deleted`; `DeleteUser` deletes the user's tokens in the same transaction. Decide whether a deleted username can be registered again; the default is no | Old password and old token both return 401 |
| SEC-07 | H4 | `TRUSTED_PROXIES` (CIDR list, empty by default). Forwarded headers are read only when the peer address is in it. Add a limiter keyed on the username, so one account cannot be attacked from many addresses | Header rotation from an untrusted peer does not reset the count |
| SEC-08 | H5 | Global `http.MaxBytesReader` (start at 1 MiB for JSON routes), a configurable per-file cap for uploads, and a real per-user quota that `FileWrite` checks before it writes. Handle the `io.ReadAll` error that is ignored today. The app routes in #53 already cap bodies; use the same approach | 413 on an oversized body; a write past quota stores nothing; `Quota` reports a real `Max` |
| SEC-09 | H7 | After a successful legacy login, re-hash to bcrypt in the same request. Compare with `subtle.ConstantTimeCompare`. Export a count of legacy hashes; after an agreed date, accounts still on SHA-256 must reset | The stored hash is bcrypt after one login |
| SEC-10 | M6 | `/v1/users/get` requires a token, or returns only what the login screen shows | Anonymous call gets 401 or the reduced shape |
| SEC-11 | M5, M4 | Go 1.22 `ServeMux` patterns with path segments for the review routes; register `POST /api/sites` separately from the list handler | A "helpful" vote creates no review; site registration reaches its handler |
| SEC-12 | M8, L13 | A key per FiveM server, compared in constant time, with `X-Server-Id` bound to its key. The same compare for `AUTH_CODE` | A valid key for server A fails for server B |
| SEC-13 | L1 | Store `SHA-256(token)`; hash existing rows in place in a migration; purge expired rows hourly | A database dump holds no usable session |

**Scope question for G1.** PulsarIMS (7% covered) and FiveM (26%) carry findings M8 and H9 and are not part of the app platform. Putting each behind an enable flag that is off by default would shrink what a public deployment exposes. This is question Q9 in Doc 09.

## G2 — Deployable

### OPS-01: migrations (M3)

- Adopt one runner (goose is the recommendation: it embeds SQL files and supports both drivers) with a tracking table.
- Keep one ordered set of migrations. Where SQLite and Postgres differ, keep paired files, as `migrations/` already does for 000–013.
- Existing databases are marked as already at version 013; nothing is re-applied.
- The `app_kv` table that #53 creates at start moves into a migration, so the server creates no schema on its own.
- Development applies migrations at start. Deployments run `pulsaros-api migrate up` as a separate step, and the server refuses to serve when the schema is older than the binary expects.
- Test schemas are built from the migrations, which removes the hand-copied schemas that caused M11.

### OPS-02: Postgres parity (M2)

Fix `is_read = 1` and `is_deleted = 1` to bound booleans, then run the service tests against both drivers in CI. Today unit tests run on SQLite only, which is how SQLite-only SQL passes CI. The sweep also lists any other fragile SQL it finds, such as `LIKE` patterns built from user paths (L15), for SEC-15.

### OPS-03: CORS and one access-code mechanism (M1, N2)

Three things are wrong at once: `AuthCode` wraps `CORS`, so preflights fail; the server reads a header while the frontend sends `?ac=`; and an app window cannot send either.

1. Order the chain `CORS → AuthCode → …` and let `OPTIONS` through `AuthCode`.
2. The frontend sends the `X-Auth-Code` header on every API call; the `?ac=` form is removed.
3. App UI files are requested by the browser for an iframe, so they cannot carry a header. Recommended: the desktop asks the API for a short-lived signed token and loads the UI from a path that contains it (`/v1/apps/ui/<token>/index.html`). A token in the path carries over to the page's relative asset URLs; a query parameter would not. This also fits the origin work in APP-02.

Alternative: exempt UI assets from `AUTH_CODE`, on the grounds that bundles are not secret. It is simpler and leaks which apps a protected server hosts. Decision A14 in Doc 09.

### OPS-04 and OPS-05: listening, TLS and timeouts (M10, H9, L17)

- `LISTEN_ADDR` replaces the localhost default and the 421 on unknown `Host` headers; `ARCOS_LISTEN_CONFIG_OVERRIDE` keeps working for one release with a warning.
- `DB_SSLMODE` defaults to `require` when the database host is not local. The DSN is built with `net/url`, so passwords with spaces or quotes work.
- `http.Server` gets `ReadHeaderTimeout`. Streaming handlers (`/api/pims/alerts/stream`, `/api/sites/*/stream`, and any stream the app event hub serves) clear their write deadline with `http.ResponseController`. Shutdown drains requests and stops script VMs.

### OPS-06 to OPS-08: a place to run it

Neither PulsarOS repo has a Dockerfile, task definition or infrastructure code, although the retired branch was called `dev-ecs`. These three items are new in this plan.

| Item | What | Notes |
| --- | --- | --- |
| OPS-06 | Multi-stage image running as a non-root user; compose file with Postgres; readiness endpoint that checks the database and schema version; a configuration reference | The reference lists every variable the code reads: `DB_NAME`, `DB_SSLMODE`, `STORAGE_BACKEND`, `USERFILES_DIR`, `SCRIPT_APPS_DIR`, `AUTH_CODE`, `SESSION_LIFETIME`, plus the new `LISTEN_ADDR`, `TRUSTED_PROXIES` and the limits from SEC-08 and LANG-01 |
| OPS-07 | Staging on the chosen platform (question Q5 in Doc 09), deployed from the default branch; secrets in the platform's store; nightly database and user-file backups; one rehearsed restore | Needs persistent storage for user files when `STORAGE_BACKEND` is disk |
| OPS-08 | JSON logs with a request ID; counters for failed logins, rate-limit hits, script budget and memory kills, and live VMs; error reporting | APP-06 builds its per-app dashboards on these counters |

**One replica (M9).** The IPC registry, script VMs, the app event hub, sites, the auditor and rate limiters live in process memory. The deployment runs exactly one instance, and the configuration reference says so. Moving that state out (OPS-09) is deferred until a second replica is actually needed.

## Public-exposure checklist

The API may face the public internet when every line is true.

- [ ] C2 and C3 closed (G0), and the owner's password rotated.
- [ ] Every write route requires a token, proven by the route-table test (SEC-05).
- [ ] H3, H4, H5 and H7 closed; session tokens hashed at rest.
- [ ] VM memory limits on (LANG-01) and the bytecode loader fuzzed (LANG-02).
- [ ] Migrations applied by the runner on Postgres with TLS; backups running and a restore rehearsed.
- [ ] Timeouts and streaming correct (OPS-05); single replica enforced.
- [ ] The frontend build sets no `VITE_PB_ADMIN_*` variable. This is a deployment rule from today; FE-01 removes the code path in G3.
- [ ] Logs show failed logins and killed scripts.

## What this doc changes in the project docs

- The audit's fix-plan steps 2–6 map to G0–G2 here. Its step 1 (pick one line per repo) is done, and its steps 7 and 8 are in Docs 05 and 03.
- The analysis estimated 1–2 days for C2, half a day for C3, 3–4 days for the auth sweep and 3–5 days for deployment blockers: 7.5 to 11.5 days. The same scope here is 13 days, because the sweep also takes M5, M8, L1 and the route-table test. Container, staging, observability, the race detector and repo hygiene add 5.75 days that no earlier doc estimated.

# PulsarOS development plan

The plan that takes PulsarOS, the PulsarOS API and PulsarScript from today's state to a
publicly deployable platform for installable apps: eight gates (G0–G7) plus a weekly health
track, 78 backlog items, about 122 developer-days.

**Approved 23 Nov 2026.** Decisions A12–A21 were approved as recommended, and the recommended
answer was adopted for every open question that had one. Later on 23 Nov 2026, the plan was
reconciled with `pulsaros-api/openspec/` and empirical findings from building Markdown Viewer and
probing PulsarScript against the RPC budget (adding decisions A22–A26, OpenSpec proposals
`add-app-file-handles`, `add-app-sdk-theme-and-urls`, `add-app-sdk-ui-kit` and
`update-fruit-dev-workbench`, and items `LANG-17`, `LANG-18`, `APP-09`–`APP-12`, `FE-16`, `DX-07`).
Doc 09 records this. The "Status: proposed" lines at the top of the other docs predate the approval.

## Read in this order

| Doc | What it answers |
| --- | --- |
| [00 Master plan](00-master-plan.md) | What happens, in what order, by when. Start here |
| [08 Backlog](08-backlog.md) | Every item with its estimate, dependencies and acceptance test |
| [01 Findings and defect register](01-findings-and-defect-register.md) | Every finding (C, H, M, N, L, D, F IDs), its status and what closes it |
| [09 Decisions, risks and open questions](09-decisions-risks-and-open-questions.md) | A1–A21, the risk register, Q1–Q13 and their answers |
| [02 API security and deployment](02-api-security-and-deployment.md) | SEC and OPS items: G0–G2 in pulsaros-api |
| [03 PulsarScript language and runtime](03-pulsarscript-language-and-runtime.md) | LANG items: memory limits, Language 1.0, standard library, performance |
| [04 Installable app platform](04-installable-app-platform.md) | APP items: the merge train, browser proof, the navigation leak, publishing rules |
| [05 Frontend hardening and health](05-frontend-hardening-and-health.md) | FE items: security fixes, the type baseline, session storage |
| [06 Developer tooling and docs](06-developer-tooling-and-docs.md) | DX items: formatter, linter, language server, Script Studio, debugger |
| [07 Testing, CI and release engineering](07-testing-ci-and-release-engineering.md) | QA and REL items: gates per milestone, coverage, versions, environments |

By repository: **pulsaros-api** is mostly 02, **pulsarscript** is 03, **pulsaros** (the
frontend) is 05, and work that spans the three repos is in 04 and 07.

## Working rules (from Doc 00)

1. One backlog item, one reviewable PR, titled with its ID (for example `SEC-04`) and linking
   the finding it closes in Doc 01.
2. A bug fix starts with a failing test. A language change starts as a spec diff plus
   conformance cases.
3. Cross-repo changes merge language first, then the API on a tag, then the frontend.
4. A gate is met when its exit test passes in CI.

## Keeping these files current

The same ten files are in `docs/plan/` in all three repositories. When the plan changes
(a finding closes, a decision is made, an estimate moves), update the file in the PR that
causes the change, and copy it to the other two repos.

Copied on 23 Nov 2026 from the PulsarOS project in claude.ai. Its older docs (the audit
report, the detailed repository analysis, the PulsarScript development plan and the
File Manager plan) stay there as the dated record.

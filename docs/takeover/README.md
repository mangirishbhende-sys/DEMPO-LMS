# Takeover pack

Deliverables for the Dempo Learn LMS Takeover Brief, one per task.

| Task | Deliverable |
|---|---|
| 1. Orientation brief | [01-orientation-brief.md](01-orientation-brief.md) |
| 2. Truth reconciliation | [02-contradictions.md](02-contradictions.md) + the root [README.md](../../README.md) |
| 3. Get it running | [03-failure-log.md](03-failure-log.md) |
| 4. Gap audit vs Google Classroom | [04-gap-audit.md](04-gap-audit.md) |
| 5. Close one gap (exam robustness) | [05-exam-robustness-spec.md](05-exam-robustness-spec.md) + branch `feat/exam-robustness` |
| 6. Make it your own | [06-design-rationale.md](06-design-rationale.md) + branch `design/mandovi-rebrand` + [contrast-check.mjs](contrast-check.mjs) |
| 7. Takeover memo | [07-takeover-memo.md](07-takeover-memo.md) |
| Issues & PRs | [github-issues-and-prs.md](github-issues-and-prs.md) |

## Branches (stacked, each merges cleanly on the previous one)

```
main
 └─ fix/openapi-codegen-drift   restore removal-impact endpoint to the spec
     └─ feat/exam-robustness    timer, auto-save, auto-submit, per-user rate limit
         └─ design/mandovi-rebrand   tokens, brand constant, honest copy, a11y fixes
             └─ docs/takeover-pack   README + this folder
```

Each code branch was verified **on its own** (later changes stashed): `pnpm run typecheck`, the API test suite against Postgres 17, and the web build.

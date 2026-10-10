# GitHub Issues and PRs (file the Issue first, then open the PR that links it)

Open every PR **in your own fork** (`mangirishbhende-sys/copy-Learn-LMS`), never against the original repo. Each PR's base is the previous branch in the stack.

---

## Issue 1 — Regenerating the API client deletes a feature the app depends on

**Symptom:** after a teammate edits `lib/api-spec/openapi.yaml` and runs `pnpm --filter @workspace/api-spec run codegen`, the build breaks in `artifacts/api-server/src/routes/groups.ts` and `artifacts/dempo/src/components/course-groups.tsx`. Removing a student from a group then loses its "this will affect N tasks" warning.
**How verified:** ran codegen on an unmodified checkout. 84 lines vanished from `lib/api-zod` and `lib/api-client-react`, all for `GetGroupRemovalImpact`, which is absent from `openapi.yaml`.
**Severity:** Medium (a latent build break; CI does not run codegen).
**Who it hurts:** every developer, the next time anyone touches the API.
**Proposed fix:** declare the endpoint in the spec. Separately, add a CI step that runs codegen and fails on `git diff`.

**PR:** `fix/openapi-codegen-drift` → base `main`. "Closes #<issue 1>".

---

## Issue 2 — Students lose all quiz answers if WiFi drops; quizzes accept submissions after the due date

See the full text in [05-exam-robustness-spec.md §5](05-exam-robustness-spec.md#5-github-issue-to-file-before-the-pr).

## Issue 3 — During an exam, students on campus WiFi will be blocked with "Too many requests"

**Symptom:** with a few hundred students on the college network, pages and saves start failing with HTTP 429 "Too many requests, please slow down."
**How verified:** reading `artifacts/api-server/src/app.ts`. The limiter allows 240 requests/minute **per IP**, with no `keyGenerator`. Campus traffic leaves through one NAT IP, so 300 students averaging more than 0.8 requests/minute each exhaust it.
**Severity:** High (exam-day outage). **Who it hurts:** every student on campus at once.
**Proposed fix:** key the limit by signed-in user (Clerk user id) and fall back to IP for anonymous requests.

**PR for Issues 2 + 3:** `feat/exam-robustness` → base `fix/openapi-codegen-drift`. "Closes #<issue 2>, closes #<issue 3>".

---

## Issue 4 — The interface looks like a template, and blocks zoom on phones

**Symptom:** default palette and typography; the name is hard-coded in 20 places. On a phone, students cannot pinch-zoom (`index.html` `maximum-scale=1`). Link previews point to an unrelated Replit app. The landing page promises AI grading, which is off by default.
**How verified:** `artifacts/dempo/index.html:5,12-18`; `grep -r "Dempo Learn" artifacts/dempo/src` (20 hits in 8 files); `.env.example:27`.
**Severity:** Medium (adoption, and an accessibility failure under WCAG 1.4.4).
**Proposed fix:** theme tokens plus a single brand constant; see [06-design-rationale.md](06-design-rationale.md).

**PR:** `design/mandovi-rebrand` → base `feat/exam-robustness`. "Closes #<issue 4>".

---

## Issue 5 — There is no README; the documents contradict each other and the code

**PR:** `docs/takeover-pack` → base `design/mandovi-rebrand`. "Closes #<issue 5>".

---

## Open issues to file (not fixed by us)

| Title (symptom-first) | Evidence |
|---|---|
| Health check reports the app as down when only the Clerk key is wrong, with no log line | `app.ts` mounts `clerkMiddleware` before `/api/healthz`; failure log row 11 |
| Assignments accept work after the due date, with no late flag and no way to resubmit | `routes/submissions.ts:165,182` |
| `pnpm install` fails on Windows with "'sh' is not recognized" | `package.json:6`; failure log row 5 |
| Every generated file shows as changed for Windows contributors | no `.gitattributes`; failure log row 6 |
| Test suite only passes with the previous owner's personal email | `.github/workflows/ci.yml:42` |
| Database TLS certificate is not verified, though the docs say it is | `lib/db/src/index.ts`, `MIGRATE-SUPABASE.md:196` |
| Root `pnpm.overrides` is silently ignored by pnpm 11 | `package.json:12-17`; failure log row 4 |

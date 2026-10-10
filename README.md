# Mandovi (formerly "Dempo Learn")

A learning management system for **Srinivassa Sinai Dempo College, Goa**: about 2,000 students and 200 staff, one college, India.

Teachers run courses, assignments, timed quizzes, a weighted gradebook, attendance and discussions. Students submit work in any format and see their marks. Deans and course coordinators get oversight and analytics.

> **Start here.** This README is the entry point. The other root documents are **historical and partly wrong**. Read [`docs/takeover/02-contradictions.md`](docs/takeover/02-contradictions.md) before trusting any of them.

| Document | Status |
|---|---|
| `ARCHITECTURE.md`, `PLAN.md` | The *intended* design (DigitalOcean Bangalore). Not what is deployed. `PLAN.md` is a 23 Jul snapshot. |
| `DEPLOY-VERCEL.md`, `MIGRATE-SUPABASE.md` | **The current deployment path** (Vercel + Neon, moving to Supabase Mumbai). |
| `DEPLOY.md` + `render.yaml` | Older free Render demo. Superseded. |
| `replit.md`, `.replit` | The original Replit prototype. Stack notes are still useful; product notes are out of date. |
| [`docs/takeover/`](docs/takeover/) | Our takeover pack: orientation, contradictions, failure log, gap audit, exam spec, design rationale, memo. |

## What it is built with

* pnpm monorepo (`pnpm-workspace.yaml`)
* Web: React 19, Vite, Tailwind CSS v4, shadcn/ui
* API: Express 5
* Database: PostgreSQL with Drizzle ORM
* Auth: Clerk
* API contract: OpenAPI → Orval codegen
* Storage: S3-compatible
* Email: MSG91 (optional)

| Path | What lives there |
|---|---|
| `artifacts/dempo/` | The web app. Theme tokens: `src/index.css`. Product name: `src/lib/brand.ts`. |
| `artifacts/api-server/` | The API. Routes: `src/routes/`. Permission helpers: `src/lib/authz.ts`. |
| `lib/db/src/schema/` | Database tables (the real source of truth for data) |
| `lib/api-spec/openapi.yaml` | API contract. **Edit this, then run codegen; never hand-edit `lib/*/generated`.** |
| `artifacts/mockup-sandbox/` | Design playground from the Replit era. Not deployed. |

## Offline demo (no accounts, no internet)

For presenting on a laptop: set `LOCAL_DEMO_AUTH=true` and `VITE_LOCAL_DEMO_AUTH=true` in `.env` (plus `DATABASE_URL` and `PORT=8080`), then run:

```bash
pnpm --filter @workspace/db run push
```
```bash
pnpm --filter @workspace/scripts run seed-demo
```

Start the API and web app as in step 8 below. The sign-in page then lists demo users (teacher/admin, dean, three students). The demo course has invite code `DEMOHR` and includes a 10-minute timed quiz.

**Guard rails** (`artifacts/api-server/src/lib/demoAuth.ts`): the server refuses to start in demo mode when `NODE_ENV=production`, accepts demo logins only from this computer, and only for user ids starting `demo_`. **Never enable it on a deployed server.**

## Run it locally (tested on Windows 10; works the same in macOS/Linux shells)

Every failure we hit getting here is logged in [`docs/takeover/03-failure-log.md`](docs/takeover/03-failure-log.md).

1. **Install** [Node.js](https://nodejs.org) 22 or newer, and [Git](https://git-scm.com). Then:
   ```bash
   npm install -g pnpm@11.15.1
   ```
   Do not rely on `corepack`: it is not bundled with Node 25+.
2. **Windows only:** run all commands in **Git Bash**, not PowerShell or cmd. The repo's scripts use `sh` and `export`. Before cloning, run:
   ```bash
   git config --global core.autocrlf false
   ```
   Otherwise codegen shows every generated file as changed.
3. **Clone and install:**
   ```bash
   pnpm install
   ```
4. **Create the database.** Any Postgres 16+ works: a free [Neon](https://neon.tech) project, or a local one.
5. **Create a free Clerk development app** at [clerk.com](https://clerk.com). Copy its publishable key (`pk_test_…`) and secret key (`sk_test_…`).
6. **Create `.env` at the repo root.** Copy `artifacts/api-server/.env.example`, then set:
   ```
   DATABASE_URL=postgres://…
   CLERK_PUBLISHABLE_KEY=pk_test_…
   CLERK_SECRET_KEY=sk_test_…
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_…      # same value; missing from .env.example
   ADMIN_EMAILS=you@example.com              # the email you will sign in with → teacher + admin
   PORT=8080
   ```
   `.env` is git-ignored. **Never commit it and never paste keys into chat.**
7. **Create the tables:**
   ```bash
   pnpm --filter @workspace/db run push
   ```
8. **Start everything** in two Git Bash terminals at the repo root. The API does not read `.env` by itself, so load it first.

   Terminal 1, the API on :8080:
   ```bash
   set -a && source .env && set +a && pnpm --filter @workspace/api-server run dev
   ```
   Terminal 2, the web app on :5173 (Vite reads the root `.env` itself):
   ```bash
   pnpm --filter @workspace/dempo run dev
   ```
   `dev.ps1` does the same in PowerShell, but it calls `corepack pnpm`, so it only works on Node ≤ 24.
9. Open http://localhost:5173 and sign in with your `ADMIN_EMAILS` address.

**Run the tests.** The API tests need a real, disposable database (use a separate one; they write test rows). The `ADMIN_EMAILS` value is the one `admin.test.ts` expects.
```bash
DATABASE_URL=postgres://… NODE_ENV=test ADMIN_EMAILS=pravendalal@gmail.com pnpm --filter @workspace/api-server run test
```
**Typecheck everything:**
```bash
pnpm run typecheck
```
**After editing `openapi.yaml`:**
```bash
pnpm --filter @workspace/api-spec run codegen
```

## Where it deploys

**Vercel** (`vercel.json`; SPA on the CDN, API as one function in `api/index.mjs`). Database on **Neon (US)** today, with a planned move to **Supabase Mumbai** (`MIGRATE-SUPABASE.md`). CI (`.github/workflows/ci.yml`) typechecks, tests and builds on every push. Do not deploy to the original owner's project. Deploy your own.

## Known broken or risky (verified)

| What | Where | Status |
|---|---|---|
| Quiz answers lost on WiFi drop; late quiz submissions accepted | `routes/quizzes.ts` | **Fixed** in `feat/exam-robustness` |
| Rate limit per IP would throttle a whole campus during exams | `api-server/src/app.ts` | **Fixed** in `feat/exam-robustness` |
| Regenerating the API client deleted a live endpoint | `lib/api-spec/openapi.yaml` | **Fixed** in `fix/openapi-codegen-drift` |
| `/api/healthz` returns 500 (with no log) if Clerk keys are missing | `api-server/src/app.ts` | Open |
| Assignments: due date not enforced, no late flag, no resubmission | `routes/submissions.ts` | Open (gap audit job 3) |
| Email notifications off by default; nobody is told about new work | `.env.example:35` | Open (configure MSG91) |
| Live data is in the US, not India | `DEPLOY.md:46` | Open (run `MIGRATE-SUPABASE.md`) |
| Windows: `pnpm install` / `dev` scripts need `sh`/`export` | `package.json:6`, `api-server/package.json:7` | Workaround: Git Bash |
| `pnpm.overrides` in root `package.json` silently ignored by pnpm 11 | `package.json:12` | Open (harmless today) |
| Test suite hard-codes the previous owner's personal email | `ci.yml:42`, `admin.test.ts` | Open |
| DB TLS certificate is not verified (`rejectUnauthorized: false`) | `lib/db/src/index.ts` | Open; the docs wrongly say it is verified |
| "Demo course DEMOHR" from `replit.md` does not exist | — | No seed data |
| Accessibility not audited; 360 px tables unverified | — | Open |

## Where to look first

* **Something about permissions:** `artifacts/api-server/src/lib/authz.ts` and `.agents/memory/role-revocation-authz.md`.
* **Changing the look:** tokens in `artifacts/dempo/src/index.css`, then shared components in `src/components/ui/`. Re-run `node docs/takeover/contrast-check.mjs` after changing colours.
* **Adding an endpoint:** `openapi.yaml` → codegen → route in `artifacts/api-server/src/routes/` → test next to it.
* **Hard-won gotchas** from the previous owner: `.agents/memory/*.md`.

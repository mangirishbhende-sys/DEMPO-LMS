# Task 1 — Orientation brief

*Written before installing anything. The root `.md` files were read in last-changed order:
`replit.md` (20 Jul) → `ARCHITECTURE.md` (21 Jul) → `DEPLOY.md` (22 Jul) → `PLAN.md` (23 Jul) → `DEPLOY-VERCEL.md` (24 Jul, 04:31) → `MIGRATE-SUPABASE.md` (24 Jul, 13:30).
Dates come from `git log -1 -- <file>`. Every claim below cites a file.*

## What does this product do?

It is a web-based learning management system (LMS) for one college:

* **Courses.** Teachers create courses. Students join with an invite code, but only if their email is on that course's roster allow-list (`replit.md:35`, `ARCHITECTURE.md:181`).
* **Assignments.** Submissions can be text, files, links, video or audio (`replit.md:3`; `lib/db/src/schema/submissions.ts`).
* **Grading.** Optional AI-drafted grades, which a human accepts or overrides (`ARCHITECTURE.md:128-145`). AI grading is **off by default** (`artifacts/api-server/.env.example:27`).
* **Plagiarism.** A word-overlap similarity score computed on the server, with no external service (`ARCHITECTURE.md:132`; `artifacts/api-server/src/lib/similarity.ts`).
* **Much more than the docs say.** The route list in `artifacts/api-server/src/routes/` also includes quizzes, a weighted gradebook, rubrics, attendance, discussions, groups, a learning journal, a student planner, analytics, early alerts, transcripts and a DPDP data export (`privacy.ts`). `replit.md:27` lists only 7 of these 30+ route modules.

## Who are its users?

* **Target:** one college of about 2,000 students and 200 staff in India (`ARCHITECTURE.md:4`). The college is Srinivassa Sinai Dempo College, Goa (`artifacts/dempo/src/pages/legal.tsx:6`).
* **Roles in the documents:** `teacher | student | unassigned` (`replit.md:34`, `ARCHITECTURE.md:180`, and the comment at `lib/db/src/schema/users.ts:8`).
* **Roles in the code:** also `dean` and `course_coordinator` (`artifacts/api-server/src/lib/authz.ts:232,253`), plus an `isAdmin` flag (`users.ts:13`). Admins come from the `ADMIN_EMAILS` environment variable (`.env.example:22-24`). Access is invite-only (`artifacts/dempo/src/router.tsx:16`).

## What is it built with?

* **Monorepo:** pnpm workspaces with 4 apps/scripts and 7 libraries (`pnpm-workspace.yaml:37-41`).
* **Web:** React 19, Vite, Tailwind CSS v4, shadcn/ui components, wouter routing, TanStack Query (`artifacts/dempo/package.json`; `ARCHITECTURE.md:66`).
* **API:** Express 5 (`artifacts/api-server/package.json`).
* **Database:** PostgreSQL through Drizzle ORM. `pnpm-workspace.yaml:55` catalogs `drizzle-orm`, and `lib/db/src/index.ts:1-2` uses the `pg` driver.
* **API contract:** `lib/api-spec/openapi.yaml`, from which Orval generates typed clients (`lib/api-spec/orval.config.ts`).
* **Auth:** Clerk (`@clerk/express`, `@clerk/react`). Identity data is stored in the US, which the docs flag as cross-border (`ARCHITECTURE.md:183`).
* **Storage:** any S3-compatible service (`.env.example:7-17`).
* **Email:** MSG91 (`artifacts/api-server/src/lib/email.ts`).

## What state is it in?

**It half-works, and the paperwork is ahead of the product.**

* **Tests and CI exist.** There is a CI pipeline (`.github/workflows/ci.yml`) and 17 test files (`*.test.ts`).
* **Nobody agrees where it runs.** Five deployment stories coexist: Replit (`.replit`), Render Singapore (`render.yaml`, `DEPLOY.md`), Vercel Mumbai (`vercel.json`, `DEPLOY-VERCEL.md`), DigitalOcean Bangalore (`ARCHITECTURE.md:35-44`, `PLAN.md:158-167`, labelled "settled"), and a Supabase migration (`MIGRATE-SUPABASE.md`). The newest doc and the code (`api/index.mjs`, `vercel.json`) point to **Vercel + Neon, moving to Supabase**.
* **The plan is out of date.** `PLAN.md` was last edited on 23 Jul. Its Stage A tasks (S3 storage, MSG91 email, AI toggle, rate limiting) were already done in later commits (`b9f6dba`, `642a6ff`, `761e643`, `88f82d9`), yet the plan still lists them as to-do.
* **Abandoned work.** These were left behind:
  * `artifacts/mockup-sandbox` (a design playground)
  * `@replit/connectors-sdk` in the root `package.json`
  * the `stripe-replit-sync` exclusion in `pnpm-workspace.yaml:35`, even though payments were dropped (`PLAN.md:108`)
  * "expo" comments in `pnpm-workspace.yaml:58`, although there is no mobile app
  * a demo course "seeded with invite code `DEMOHR`" (`replit.md:42`), which **no seed file creates**.
* **The last five things the previous owner worked on** (`git log`, newest first):
  1. course-plan autosave data loss
  2. Word/PDF export
  3. autosave for notes and journal entries
  4. dialog overflow
  5. assignment delete

  Autosave was patched twice in one week, which suggests reliability is fragile.

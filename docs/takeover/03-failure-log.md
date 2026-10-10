# Task 3 — Getting it running: failure log

**Machine:** Windows 10 Home 19045, PowerShell 5.1, no developer tools preinstalled.
**Date:** 10 Oct 2026. **Repo:** fork `mangirishbhende-sys/copy-Learn-LMS` @ `02b6bc7`.

**Outcome:** the API runs, all **175** original API tests pass against a local Postgres 17, and both apps build.
The web app cannot be signed into until a Clerk account exists (row 11). That needs a human to create the account
and is the only remaining blocker.

| # | Command run | Exact error | What we tried | What fixed it | Root cause |
|---|---|---|---|---|---|
| 1 | `git --version`, `node --version` | `The term 'git' is not recognized…` / same for `node`, `npm` | — | `winget install OpenJS.NodeJS` and `winget install Git.Git` | Fresh Windows machine. No README says what to install; `dev.ps1:11` only says "Node 24+". |
| 2 | `winget install OpenJS.NodeJS --version 24` | `No applicable installer found` | Pinning v24 | Installed the latest (**Node 26.8.1**) instead | winget has no Node 24 package. `.node-version` says `24` and `render.yaml:30` says `24`, but CI (`.github/workflows/ci.yml:49`) and Vercel (`DEPLOY-VERCEL.md:22`) use **22**. Three different "right" versions. |
| 3 | `corepack --version` | `The term 'corepack' is not recognized…` | — | `npm install -g pnpm@11.15.1` (version taken from `vercel.json:4`) | Corepack is no longer bundled with Node 25+. `dev.ps1:49`, `vercel.json`, `render.yaml` and CI all depend on `corepack`. **Will break on any newer Node.** |
| 4 | any `pnpm` command | `[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides"` | — | Not fixed (logged as an Issue) | `package.json:12-17` pins React through `pnpm.overrides`, which pnpm 11 silently ignores. The React pin only survives because `pnpm-workspace.yaml:59-61` also pins it. |
| 5 | `pnpm install` | `. preinstall: 'sh' is not recognized as an internal or external command` → `ELIFECYCLE Command failed with exit code 1` | — | Put `C:\Program Files\Git\bin` on `PATH` for the session (the same trick `dev.ps1:43-45` uses) | `package.json:6` `preinstall` is a Unix shell one-liner. On Windows, pnpm runs scripts in `cmd.exe`, which has no `sh`. |
| 6 | `pnpm --filter @workspace/api-spec run codegen` (on an **unmodified** checkout) | No error. `git status` shows **every generated file modified** | Read the diff: only line endings | `git config core.autocrlf false` + re-checkout | Git for Windows defaults to CRLF; the code generator writes LF. Every Windows contributor gets a 100-file noise diff. Needs a `.gitattributes`. |
| 7 | same codegen, after fixing #6 | 84 deleted lines: `GetGroupRemovalImpact…` disappears from `lib/api-zod` and `lib/api-client-react` | `grep` for the symbol → used by `routes/groups.ts:279` and `course-groups.tsx:119` | Added the endpoint to `lib/api-spec/openapi.yaml` (branch `fix/openapi-codegen-drift`) | Someone hand-edited generated code instead of the spec. `replit.md:26` calls the spec the "source of truth" — it wasn't. CI never runs codegen, so nothing caught it. |
| 8 | `pnpm --filter @workspace/api-server run dev` (the command in `replit.md:8`) | `'export' is not recognized as an internal or external command` | — | Ran `build` then `node dist/index.mjs` directly with env vars set in PowerShell | `artifacts/api-server/package.json:7` uses Unix `export NODE_ENV=…`. Fails on Windows. |
| 9 | `node artifacts/api-server/dist/index.mjs` | `Error: DATABASE_URL must be set. Did you forget to provision a database?` | — | Portable Postgres 17 (`@embedded-postgres/windows-x64`) on port 54329, no install/admin needed | `lib/db/src/index.ts:7` throws at import time. Expected — but no doc says how to get a *local* database; every doc assumes a cloud one (Neon, Supabase, DO). |
| 10 | same, with `DATABASE_URL` | `Error: PORT environment variable is required but was not provided.` | — | `$env:PORT = "8080"` | `artifacts/api-server/src/index.ts:7-13` has no default port, unlike the web app (`vite.config.ts:10` defaults to 5173). |
| 11 | `Invoke-WebRequest http://localhost:8080/api/healthz` | **HTTP 500** `{"error":"Internal server error"}`, and **nothing in the server log** | Re-ran with a correctly-shaped placeholder Clerk key → `200 {"status":"ok"}` | Needs real Clerk keys in `.env` (see README) | `app.ts` mounts `clerkMiddleware` before `/api`, so **even the health check needs valid Clerk keys**. The deploy health checks (`render.yaml:19`, `DEPLOY-VERCEL.md:67`) will report the app as down for a config problem, and the error is swallowed. |
| 12 | `pnpm --filter @workspace/dempo run build` (no `.env`) | Build **succeeds** | Opened the built app | — | `artifacts/dempo/src/lib/auth.tsx:19-21` throws `Missing Publishable Key` at runtime → blank white page. Failing at build time would be kinder. |
| 13 | `pnpm --filter @workspace/db run push-force` → `pnpm --filter @workspace/api-server run test` | Pass: **17 files, 175 tests** | Needed `ADMIN_EMAILS=pravendalal@gmail.com` | Copied from CI | `admin.test.ts` asserts the *previous owner's personal email* is the admin (`ci.yml:42`). A personal address hard-wired into the test suite. |
| 14 | Editing a `.tsx` file with PowerShell `Get-Content` / `Set-Content` | `©` became `Â©` and `—` became garbage | `git checkout --` the file | Edit with an editor or Node, never PowerShell 5.1 text cmdlets | PowerShell 5.1 reads BOM-less UTF-8 as ANSI. Not the repo's fault, but a real trap for every Windows teammate. |

## What a new Windows teammate needs (now in the README)

1. Install Node (any version ≥ 22) and Git for Windows.
2. `npm install -g pnpm@11.15.1` (do not rely on corepack).
3. Run every `pnpm` command in **Git Bash**, not PowerShell or cmd (fixes rows 5, 8).
4. `git config core.autocrlf false` before cloning (row 6).
5. A Postgres database (local or Neon free tier) → `DATABASE_URL`.
6. A free Clerk *development* app → `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`.
7. `PORT=8080` for the API.

## Lessons

* The error names the symptom, not the cause. Rows 5, 8 and 11 all *look* like broken code. They are actually OS and config assumptions.
* Three of the fourteen failures (4, 6, 7) produced **no error at all**. They only showed up by reading `git status` and warnings.

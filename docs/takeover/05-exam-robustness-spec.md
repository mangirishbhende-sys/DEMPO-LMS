# Task 5 — Close one gap: exam robustness (product track)

**Commercial premise served:** #1, "exam-grade reliability: auto-save, server-side timers, survives flaky campus WiFi" (Takeover Brief §2).
**Branch / PR:** `feat/exam-robustness`. **Tests:** `artifacts/api-server/src/routes/quizzes.test.ts`, block "exam mode" (12 cases).

## 1. The problem, as a student experiences it

> I'm 25 minutes into a quiz on my phone in the library. The WiFi drops for two minutes. When it comes back I press Submit and get "Submission failed". When I reload, every answer is gone.

What the code did before this change (verified by reading it):

| Behaviour | Evidence |
|---|---|
| Answers live only in browser memory until Submit, so reloading loses everything | `pages/quiz-view.tsx` (old `StudentQuizForm`: plain `useState`, no save) |
| No time limit exists at all | `lib/db/src/schema/quizzes.ts` (old): only `dueDate` |
| The due date is **never checked** on submit, so late submissions are accepted | `routes/quizzes.ts` (old POST `/attempts`): no `dueDate` comparison |
| Rate limit is 240 requests/min **per IP**, and a campus shares one public IP | `app.ts` (old `apiLimiter`, no `keyGenerator`) |
| Teachers are told AI scores are accepted on publish, but the server never accepts them | `quiz-view.tsx:137` vs `quizzes.ts` publish-results comment |

## 2. Specification (written before the code)

### Teacher
* **S1.** A quiz may have an optional **time limit** of 1–600 whole minutes. Empty means untimed.
* **S2.** The **due date** becomes a hard close: no submissions are accepted after it, beyond a 30-second network grace.
* **S3.** Questions cannot be edited once any student has **started** (not just submitted). Otherwise saved answers would point at deleted questions.
* **S4.** In the results list, an attempt the server submitted is labelled "submitted automatically when time ran out (last saved answers)".
* **S5.** **Publish results** first submits every student still mid-quiz, using their saved answers.

### Student
* **S6.** A timed quiz shows a **Start screen** with the rules. The clock starts only when the student presses Start, never just by opening the page.
* **S7.** The deadline = **earlier of** (start + time limit) and the due date. A student who starts late gets less time, and is told so before starting.
* **S8.** The deadline is stored on the **server**. Reloading, closing the tab, switching devices or a wrong phone clock cannot change it. The browser corrects its countdown using the server's clock (`serverNow`).
* **S9.** Every change is kept **on the device immediately** and **auto-saved to the server** 1.5 seconds after typing stops. Failed saves retry every 10 seconds and on reconnect.
* **S10.** Save status is always visible **in words**, never by colour alone: "All answers saved · 10:42:07 am", "Saving…", "Not saved yet — kept on this device".
* **S11.** Warnings at 5 minutes and 1 minute appear as a toast and are announced to screen readers through an `aria-live` region.
* **S12.** At zero the browser submits automatically. If it is offline at that moment, **the server submits the last saved answers** the next time anyone opens the quiz or its results. The student's work is never lost because of their connection.
* **S13.** A submit arriving after deadline + grace **ignores the late answers** and submits the last copy saved in time. This is fair and can't be gamed by delaying the request.
* **S14.** A timed quiz cannot be submitted without first pressing Start, so the timer can't be bypassed by posting answers directly.
* **S15.** Confirm before submitting, showing how many questions are unanswered.

### Edge cases decided

| Case | Decision | Why |
|---|---|---|
| Two tabs press Start at once | One session row (unique `quiz_id + student_id`). The second tab gets the same deadline. | No double timers |
| Student's Submit races the server's auto-submit | The unique constraint on attempts plus `ON CONFLICT DO NOTHING`. The loser gets "already submitted". | Exactly one attempt |
| Untimed quiz with no due date | A session is still created silently, so auto-save works. No countdown is shown. | Same robustness for homework quizzes |
| Shared lab computer | The device copy is deleted on successful submit | Privacy |
| Teacher deletes the quiz / admin deletes the student | Sessions are deleted too (`quizzes.ts` delete, `lib/userCleanup.ts`) | DPDP erasure; previously quiz **attempts** were orphaned when a user was deleted |
| Course deactivated mid-term | Students can no longer start or submit (`canAccessCourse`) | Matches the existing policy in `.agents/memory/role-revocation-authz.md` |

### Deliberately **not** done (and why)
* **No proctoring, webcam or lockdown browser.** Invasive, a DPDP risk, and out of proportion for a college LMS.
* **No background job server.** The app runs serverless on Vercel (`DEPLOY-VERCEL.md:79-80`), so expired sessions are closed "on read" instead.
* **No question randomisation or question banks.** A separate feature, and it does not affect reliability.

## 3. API (in `lib/api-spec/openapi.yaml`)

| Method & path | Purpose |
|---|---|
| `POST /api/quizzes/{id}/session` | Start or resume. Returns `startedAt`, `deadlineAt`, `serverNow`, saved `answers`. `409` if already submitted, closed, or time is up. |
| `PUT /api/quizzes/{id}/session` | Auto-save `{answers}`. `409` "Time is up…" after the deadline, and the saved copy is submitted. |
| `POST /api/quizzes/{id}/attempts` | Submit (existing). Now deadline-aware (S2, S13, S14). |
| `Quiz.timeLimitMinutes`, `Quiz.mySession`, `QuizAttempt.autoSubmitted` | New fields |

**Data:** `quizzes.time_limit_minutes`, `quiz_attempts.auto_submitted`, and a new table `quiz_sessions`. It holds answers, `started_at`, `deadline_at`, `last_saved_at` and `save_count`, and is **kept after submission** as evidence in "my WiFi dropped" disputes.

## 4. How it was verified

* `pnpm --filter @workspace/api-server run test`: **187/187 pass**. That is the 175 original tests plus 12 new ones covering S1, S2, S3, S5, S7, S8, S9, S12, S13 and S14, against a real Postgres 17.
* `pnpm run typecheck` is clean, and the web and API builds succeed.
* Each branch was verified **on its own**, with later branches stashed, so every PR passes CI independently.
* **Not yet verified:** the browser behaviour (countdown, offline banner, auto-submit at zero) in a real signed-in session. That needs Clerk keys; see the README. Manual test script:
  1. Teacher creates a quiz with a 2-minute limit and publishes it.
  2. The student presses Start, answers one question, and watches "All answers saved".
  3. In DevTools, set Network to **Offline** and answer another question. The banner should read "Not saved yet — kept on this device".
  4. Reload the page while offline, then go back online. Both answers should be restored and saved.
  5. Wait for zero. The quiz should submit itself.
  6. The teacher's results should show the attempt.
  7. Repeat with the student closing the tab before zero. The teacher opening results should show "submitted automatically".

## 5. GitHub Issue (to file before the PR)

**Title:** Students lose all quiz answers if WiFi drops or the page reloads; quizzes accept submissions after the due date

**What happens (symptom):** A student taking a quiz loses every answer if the connection drops, the phone sleeps, or the page reloads before they press Submit. There is no way to set a time limit, and the due date doesn't close the quiz: submissions are accepted after it.

**How verified:** by reading the code. `artifacts/dempo/src/pages/quiz-view.tsx` holds answers only in `useState`, and `artifacts/api-server/src/routes/quizzes.ts` POST `/attempts` has no `dueDate` comparison. Then **proven by running the new regression test against the original route file** (`git show main:artifacts/api-server/src/routes/quizzes.ts`). Test "rejects submissions to an untimed quiz after its due date" fails with `AssertionError: expected 201 to be 409`: a submission 5 minutes after the due date was **accepted**. With the fix the test passes.

**Severity:** High. It blocks any use for internal exams, which is the first reason the brief gives for a college to pay instead of using Classroom.

**Who it hurts:** students on campus WiFi or mobile data, and teachers handling "my answers disappeared" disputes with no evidence.

**Proposed fix:** server-side quiz sessions with auto-save and a server-held deadline; see `docs/takeover/05-exam-robustness-spec.md`.

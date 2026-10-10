# Task 7 — Takeover memo

**To:** The founder
**From:** The new product team
**Re:** Is this sellable to a 2,000-student college, and what we will and won't do in the next 90 days

## 1. The short answer

**Not yet sellable, but closer than the documents suggest, and for different reasons than they give.**

The product has more working features than its own docs admit: 35 API route modules, a weighted gradebook, five roles and 175 passing tests. What blocks a sale is not missing features. It is four things:

1. **Trust on exam day.** Until this week, a WiFi drop erased a student's quiz. Late submissions were accepted. The rate limiter would have locked out a whole campus sharing one IP. We fixed all three (`feat/exam-robustness`, 187 tests passing), but nothing has been load-tested.
2. **Data residency is claimed, not true.** The live database is Neon in the **US** (`DEPLOY.md:46`) and identity is with Clerk in the US. "India-resident by default" (`ARCHITECTURE.md:15`) is a plan, not the state.
3. **Nobody can operate it.** There are five contradictory deployment stories (Replit, Render, Vercel, DigitalOcean, Supabase), no README until ours, no support model (`ARCHITECTURE.md:305`), and a test suite hard-wired to the previous owner's personal email (`ci.yml:42`).
4. **The paperwork gates are untouched.** No external pen-test, no signed privacy policy or DPAs (`ARCHITECTURE.md:301-302`, both marked "sale-blocker").

## 2. What we would do in the next 90 days

| Weeks | Do | Why it is first | Done when |
|---|---|---|---|
| 1–2 | Merge our three PRs. Pick **one** deployment (Vercel + Supabase Mumbai) and **delete** `render.yaml`, `.replit`, `DEPLOY.md`. Add `.gitattributes`. Make CI run codegen and fail on drift. | Every hour spent on five deploy paths is wasted. | One documented path; CI catches a broken spec. |
| 1–4 | Execute `MIGRATE-SUPABASE.md` so data actually lives in Mumbai. Start the DPA requests and the pen-test quote **now**: legal has the longest lead time (`PLAN.md` Stage D). | Residency is premise #2 and currently false. | The DB and files are in `ap-south-1`; vendor DPAs are requested. |
| 3–6 | **Load-test one exam:** 400 simulated students, 45-minute timed quiz, auto-save every few seconds, behind one IP. Fix what breaks. | Exam reliability is the whole pitch, and it is unproven at scale. | A written test report with numbers. |
| 3–8 | **Bulk roster CSV import** (name, email, roll no., programme, cohort; partial import with a per-row error report). Then **late flags and resubmission** for assignments, the one job where we are *worse* than Classroom (`docs/takeover/04-gap-audit.md`, job 3). | You cannot onboard 2,000 people by pasting emails. | One full programme imported in under 10 minutes. |
| 6–10 | **Free pilot with one department, one internal exam.** Turn on email (MSG91) for that department only. | A testimonial and real failure data beat any feature. | The pilot exam runs with zero lost submissions, verified from the `quiz_sessions` evidence. |
| 8–12 | Define support: a named on-call person and phone number **during exam windows only**, plus a 4-hour response target otherwise. Price it. | "Who is awake during exams?" is the first question a Head of Department asks. | A one-page support policy is signed off. |

## 3. What we will refuse to do, and why

**No: we will not switch on AI grading for the sale or the pilot.** It is the headline of the old landing page, but it is off by default for good reasons:
* compliance sign-off is pending (`ARCHITECTURE.md:145`);
* the previous team already found that student answers can steer the AI score through prompt injection (`quizzes.ts`, publish-results comment);
* one wrong AI mark in an internal exam costs more trust than the feature earns.

AI stays a teacher-side draft tool, switched on by department, after the pilot.

**No: we will not build WhatsApp/SMS, a mobile app, payments, or multi-college SaaS in these 90 days.**
* WhatsApp/SMS needs DLT registration and template approval for a nice-to-have, and email covers the pilot.
* The `expo` and `stripe` leftovers in `pnpm-workspace.yaml` show these were started and abandoned once already.
* Each one is something Google already gives away free or something nobody has asked for. None serves the four premises.

**No: we will not add proctoring, webcam monitoring or lockdown browsers.** They are invasive, a DPDP liability with 2,000 students' biometric-adjacent data, and they fail on the cheap phones our students use. Server-side timing plus auto-save solves the real problem, lost work, without surveilling anyone.

**No: we will not promise an SLA above 99.5%** until there are redundant instances and a tested restore (`ARCHITECTURE.md:217-219`). Today there is neither.

## 4. The one risk that worries us most

**Operational, not technical.** The previous owner patched autosave twice in their last week (`git log`: `02b6bc7`, `f8c302c`) and left nothing explaining why. If the college signs and the platform fails during finals, nobody on our side currently knows the system well enough to fix it at 9 pm. The 90 days are as much about building that knowledge (README, one deploy path, load test, runbook) as about features.

**Recommendation:** proceed to a **free, one-department pilot**, not a sale. Revisit pricing after the pilot exam.

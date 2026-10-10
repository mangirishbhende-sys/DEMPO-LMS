# Task 6 — Design rationale: Mandovi

**Branch / PR:** `design/mandovi-rebrand`. **Rule followed:** change tokens and shared components, never individual screens.
The palette lives in `artifacts/dempo/src/index.css` and the name in `artifacts/dempo/src/lib/brand.ts`; no screen got a hand-picked colour.

## Name and positioning

**Mandovi** is Goa's river, and the college is Srinivassa Sinai Dempo College, Goa (`pages/legal.tsx:6`). It sounds like a place, not like an AI-generated app ("Learn", "Hub").

> **Mandovi — exam-ready learning for Dempo. Coursework, marks and student data kept in India.**

Every word of that line traces to one of the brief's four reasons to pay: exam reliability, a real gradebook, data residency, and college ownership.

## Who is this for?

Students aged 18–24, mostly on phones on patchy campus WiFi, using it for hours during term and under stress during exams. Faculty use it on laptops for grading. So the design favours **calm, legibility and density** over decoration.

## Why this palette

* **Primary: deep river teal `#0F626B`.** Distinct from the default blues of template apps and from Google Classroom's green. It reads as institutional without being corporate navy. White text on it is **7.05:1**.
* **Neutrals:** cool slate, tinted slightly toward the primary so greys don't look dead next to it.
* **Semantics:** chosen dark enough to be **text**, not just backgrounds. Warning is a deep amber `#904F04` (6.35:1); a typical yellow fails on white.

Measured with `docs/takeover/contrast-check.mjs` (WCAG 2.x formula). Re-run it after any token change.

| Pair (light mode) | Ratio | | Pair (dark mode) | Ratio |
|---|---|---|---|---|
| Body text on background | 16.38:1 | | Body text on background | 15.16:1 |
| Secondary text on white | 6.10:1 | | Secondary text on background | 7.83:1 |
| Secondary text on muted panel | 5.62:1 | | Secondary text on muted panel | 6.54:1 |
| White on primary (buttons) | 7.05:1 | | Text on primary (buttons) | 8.69:1 |
| Error / success / warning / info text | 6.29 / 6.57 / 6.35 / 6.35 | | Error / success / warning / info | 5.95 / 7.56 / 9.37 / 8.07 |
| Status text inside its tinted chip (worst) | 5.16:1 | | Status text inside its chip (worst) | 5.08:1 |
| Input border vs background (needs 3:1) | 3.24:1 | | Input border vs background | 3.85:1 |

**All 40 checked pairs (20 per mode) pass.** The first draft failed one: the light input border measured 2.70:1. It was darkened and re-measured; the script is the evidence.

**Colour never carries meaning alone.** The exam timer turns amber and then red, but it also *says* the time and fires "5 minutes left" and "Less than 1 minute left" announcements. The save indicator is always words plus an icon.

## Why this typeface

**IBM Plex Sans** for everything, at weights 400/500/600/700; **Plex Mono** for figures; **Plex Serif** only for dialog titles that already used `font-serif`.

* One family keeps the interface coherent. Plex is designed for long reading on screens and has clear `1/l/I` and `0/O` shapes, which matter in roll numbers and marks.
* Plex has a **Devanagari** companion (Plex Sans Devanagari). A Konkani, Marathi or Hindi interface later would not need a new type system.
* Scale and rhythm: body line-height **1.55**, headings **1.25**, radius tightened to 6 px. `tabular-nums` keeps timers and score columns from jittering.

## Microcopy changed

| Before | After | Why |
|---|---|---|
| Landing: "Faster grading — AI drafts grades and comments" | "Exams that survive bad WiFi" | AI grading is **off by default** (`.env.example:27`). The page promised something that doesn't ship. |
| Sign-up: "Join the fun — it's free" | "Use the email your college invited." | Access is invite-only. The old line sent students to a dead end. |
| Publish results: "AI-suggested scores are accepted…" | States that AI scores are never auto-accepted | It was factually wrong at the moment marks are finalised. |
| Quiz errors: "HTTP 409 Conflict: …" | "Time is up. Your answers saved before the deadline have been submitted." | Written for a stressed student on bad WiFi. |
| Offline: (nothing — answers silently lost) | "Not saved yet — kept on this device" | Tells the student what is true and what to do (nothing). |

## Accessibility fixes made along the way

* Removed `maximum-scale=1` from `index.html`, which **blocked pinch-zoom** (WCAG 1.4.4).
* Added a global `:focus-visible` outline (2.4.7).
* Quiz options are now a real `radiogroup` with `aria-checked`. Tap targets are at least 44 px high (`min-h-11`), and questions are labelled for screen readers.

## What I deliberately left alone

* **Layout, navigation and component shapes.** They work, and changing them would be redesign for its own sake.
* **The crest/logo** (`public/logo.png`). It is the college's property, not ours to redraw.
* **Dark mode mechanics.** Already scaffolded (`next-themes` in `App.tsx`, the `.dark` block in `index.css`), so I re-themed it rather than rebuilt it.
* **Tables that may not work at 360 px.** They are noted for a follow-up; I did not verify them screen by screen.

## Before/after screenshots

**TODO — needs a signed-in session (Clerk keys).** Capture at 1280 px and 360 px:
1. landing
2. dashboard
3. course page
4. quiz (Start screen + in-progress with the timer)

Use `main` for "before" and `design/mandovi-rebrand` for "after". Save the images in `docs/takeover/screenshots/`.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startQuizSession,
  saveQuizSession,
  useCreateQuizAttempt,
  getGetQuizQueryKey,
  getListQuizzesQueryKey,
  type QuizSession,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, CheckCircle2, Circle, Timer, CloudOff, Cloud, AlertTriangle, PlayCircle,
} from "lucide-react";
import { format } from "date-fns";

/*
 * Exam-grade quiz taking. Three promises to the student:
 *  1. Nothing typed is lost: every change is kept on this device immediately
 *     and auto-saved to the server a moment later (and again on reconnect).
 *  2. The clock is the server's: reloading, closing the tab or a wrong phone
 *     clock cannot add or remove time.
 *  3. When time runs out, what was saved is submitted — even if the student's
 *     WiFi is down at that moment (the server does it).
 */

type Draft = Record<number, { selectedOption?: number; textAnswer?: string }>;
type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

const AUTOSAVE_DEBOUNCE_MS = 1500;
const RETRY_INTERVAL_MS = 10_000;

/** Turns any API failure into one calm sentence (no "HTTP 409 Conflict: …"). */
function describeError(err: unknown): { status?: number; message: string } {
  const e = err as { status?: number; data?: { error?: string } } | undefined;
  if (!e?.status) {
    return { message: "You appear to be offline. Your answers are kept on this device and will be saved when you reconnect." };
  }
  return { status: e.status, message: e.data?.error ?? "Something went wrong on our side. Your answers are kept on this device." };
}

function storageKey(quizId: number) {
  return `dempo.quiz.${quizId}.draft`;
}

function readLocalDraft(quizId: number): { answers: Draft; updatedAt: number } | null {
  try {
    const raw = localStorage.getItem(storageKey(quizId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalDraft(quizId: number, answers: Draft) {
  try {
    localStorage.setItem(storageKey(quizId), JSON.stringify({ answers, updatedAt: Date.now() }));
  } catch {
    // Storage full or blocked (private mode): the server copy still works.
  }
}

function clearLocalDraft(quizId: number) {
  try {
    localStorage.removeItem(storageKey(quizId));
  } catch {
    /* ignore */
  }
}

function draftFromSession(session: QuizSession): Draft {
  const draft: Draft = {};
  for (const a of session.answers) {
    draft[a.questionId] = {
      selectedOption: a.selectedOption ?? undefined,
      textAnswer: a.textAnswer ?? undefined,
    };
  }
  return draft;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ---------------- Entry point ---------------- */

export function StudentQuizExam({ quiz }: { quiz: any }) {
  const [session, setSession] = useState<QuizSession | null>(quiz.mySession ?? null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const timed = !!quiz.timeLimitMinutes;

  const begin = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      setSession(await startQuizSession(quiz.id));
    } catch (err) {
      const { status, message } = describeError(err);
      setStartError(message);
      // 409 = already submitted / closed / time up: show the real state.
      if (status === 409) queryClient.invalidateQueries({ queryKey: getGetQuizQueryKey(quiz.id) });
    } finally {
      setStarting(false);
    }
  }, [quiz.id, queryClient]);

  // Untimed quizzes start silently so auto-save works from the first click.
  useEffect(() => {
    if (!session && !timed) void begin();
  }, [session, timed, begin]);

  if (session) return <ExamForm quiz={quiz} session={session} />;

  if (!timed) {
    return (
      <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
        {starting ? <Loader2 className="w-6 h-6 animate-spin text-primary" /> : null}
        {startError ? (
          <>
            <p role="alert">{startError}</p>
            <Button variant="outline" onClick={begin}>Try again</Button>
          </>
        ) : (
          <p>Opening the quiz…</p>
        )}
      </div>
    );
  }

  return (
    <Card className="shadow-sm">
      <CardContent className="p-6 md:p-8 space-y-5">
        <div className="flex items-center gap-3">
          <Timer className="w-6 h-6 text-primary shrink-0" aria-hidden />
          <h2 className="text-xl font-semibold tracking-tight">
            This is a timed quiz: {quiz.timeLimitMinutes} minutes
          </h2>
        </div>
        <ul className="list-disc pl-6 space-y-1.5 text-sm text-muted-foreground">
          <li>The timer starts when you press <strong className="text-foreground">Start quiz</strong> and keeps running even if you close this page or lose WiFi.</li>
          <li>Your answers save automatically as you go. If your connection drops, keep working — they will be saved when it comes back.</li>
          <li>When time runs out, your saved answers are submitted for you.</li>
          {quiz.dueDate && (
            <li>The quiz closes at {format(new Date(quiz.dueDate), "PPP p")}. If you start late, you get less time.</li>
          )}
          <li>You can submit only once.</li>
        </ul>
        {startError && (
          <p role="alert" className="text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden /> {startError}
          </p>
        )}
        <Button size="lg" onClick={begin} disabled={starting} className="w-full sm:w-auto">
          {starting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
          Start quiz
        </Button>
      </CardContent>
    </Card>
  );
}

/* ---------------- The exam itself ---------------- */

function ExamForm({ quiz, session }: { quiz: any; session: QuizSession }) {
  const questions: any[] = quiz.questions ?? [];
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createAttempt = useCreateQuizAttempt();

  // Prefer whichever copy is newer: the server's or one kept on this device
  // while offline (e.g. the student typed with no WiFi, then reloaded).
  const [initial] = useState(() => {
    const server = draftFromSession(session);
    const local = readLocalDraft(quiz.id);
    const serverTime = session.lastSavedAt ? new Date(session.lastSavedAt).getTime() : 0;
    return local && local.updatedAt > serverTime
      ? { draft: { ...server, ...local.answers }, restoredFromDevice: true }
      : { draft: server, restoredFromDevice: false };
  });
  const [answers, setAnswers] = useState<Draft>(initial.draft);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(
    session.lastSavedAt ? new Date(session.lastSavedAt) : null,
  );
  const [statusMessage, setStatusMessage] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Server clock minus device clock, so a wrong phone clock can't cheat or panic anyone.
  const clockOffset = useRef(new Date(session.serverNow).getTime() - Date.now());
  const deadline = session.deadlineAt ? new Date(session.deadlineAt).getTime() : null;
  const [now, setNow] = useState(() => Date.now() + clockOffset.current);

  // A device copy newer than the server's counts as one unsaved change.
  const version = useRef(initial.restoredFromDevice ? 1 : 0);
  const savedVersion = useRef(0);
  const inFlight = useRef(false);
  const answersRef = useRef(answers);
  const finished = useRef(false);
  const pendingSubmit = useRef(false);
  const warned = useRef<{ five?: boolean; one?: boolean }>({});

  const closeOut = useCallback(
    (message?: string) => {
      finished.current = true;
      clearLocalDraft(quiz.id);
      if (message) toast({ title: message });
      queryClient.invalidateQueries({ queryKey: getGetQuizQueryKey(quiz.id) });
      queryClient.invalidateQueries({ queryKey: getListQuizzesQueryKey(quiz.courseId) });
    },
    [quiz.id, quiz.courseId, queryClient, toast],
  );

  const toPayload = (draft: Draft) =>
    questions.map((q) => ({
      questionId: q.id,
      selectedOption: draft[q.id]?.selectedOption,
      textAnswer: draft[q.id]?.textAnswer,
    }));

  const save = useCallback(async () => {
    if (inFlight.current || finished.current) return;
    if (version.current === savedVersion.current) return;
    inFlight.current = true;
    const sending = version.current;
    setSaveState("saving");
    try {
      const result = await saveQuizSession(quiz.id, { answers: toPayload(answersRef.current) });
      savedVersion.current = sending;
      setLastSavedAt(result.lastSavedAt ? new Date(result.lastSavedAt) : new Date());
      setSaveState("saved");
    } catch (err) {
      const { status, message } = describeError(err);
      if (status === 409) {
        closeOut(message);
      } else {
        setSaveState(status ? "error" : "offline");
        setStatusMessage(message);
      }
    } finally {
      inFlight.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz.id, closeOut]);

  const submit = useCallback(
    (auto: boolean) => {
      if (finished.current || createAttempt.isPending) return;
      pendingSubmit.current = true;
      createAttempt.mutate(
        { quizId: quiz.id, data: { answers: toPayload(answersRef.current) } },
        {
          onSuccess: () => {
            pendingSubmit.current = false;
            closeOut(auto ? "Time is up. Your answers have been submitted." : "Quiz submitted. Your answers are in.");
          },
          onError: (err) => {
            const { status, message } = describeError(err);
            if (status === 409) {
              pendingSubmit.current = false;
              closeOut(message);
            } else if (!status) {
              // Keep trying; meanwhile the server will submit the saved copy at the deadline.
              setSaveState("offline");
              setStatusMessage("You are offline, so we could not submit yet. We will keep trying. Your saved answers are safe.");
            } else {
              pendingSubmit.current = false;
              toast({ title: "Could not submit", description: message, variant: "destructive" });
            }
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quiz.id, closeOut, createAttempt],
  );

  // Every change: keep a device copy now, schedule a server save shortly.
  useEffect(() => {
    answersRef.current = answers;
    if (version.current === savedVersion.current) return; // nothing new to save
    writeLocalDraft(quiz.id, answers);
    const t = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [answers, quiz.id, save]);

  // Retry loop + reconnect handling.
  useEffect(() => {
    const retry = () => {
      if (pendingSubmit.current) submit(true);
      else void save();
    };
    const id = setInterval(retry, RETRY_INTERVAL_MS);
    window.addEventListener("online", retry);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", retry);
    };
  }, [save, submit]);

  // Warn before leaving with unsaved changes (the device copy survives anyway).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!finished.current && version.current !== savedVersion.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Clock: tick, warn at 5 and 1 minute, auto-submit at zero.
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => {
      const t = Date.now() + clockOffset.current;
      setNow(t);
      const left = deadline - t;
      if (left <= 5 * 60_000 && left > 60_000 && !warned.current.five) {
        warned.current.five = true;
        setStatusMessage("5 minutes left.");
        toast({ title: "5 minutes left", description: "Your answers are being saved automatically." });
      }
      if (left <= 60_000 && left > 0 && !warned.current.one) {
        warned.current.one = true;
        setStatusMessage("Less than 1 minute left.");
        toast({ title: "Less than 1 minute left", description: "Your saved answers will be submitted when time runs out." });
      }
      if (left <= 0 && !finished.current && !pendingSubmit.current) submit(true);
    }, 1000);
    return () => clearInterval(id);
  }, [deadline, submit, toast]);

  const update = (questionId: number, value: { selectedOption?: number; textAnswer?: string }) => {
    version.current += 1;
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  const answeredCount = questions.filter((q) => {
    const a = answers[q.id];
    return q.type === "multiple_choice" ? a?.selectedOption != null : !!a?.textAnswer?.trim();
  }).length;
  const unanswered = questions.length - answeredCount;
  const remaining = deadline != null ? deadline - now : null;
  const urgency = remaining == null ? "none" : remaining <= 60_000 ? "critical" : remaining <= 5 * 60_000 ? "low" : "ok";

  return (
    <div className="space-y-6">
      {/* Sticky status bar: time, save state, progress — all in words, not colour alone. */}
      <div className="sticky top-0 z-20 -mx-4 md:mx-0 px-4 md:px-5 py-3 bg-background/95 backdrop-blur border-b md:border md:rounded-xl flex flex-wrap items-center gap-x-5 gap-y-2">
        {remaining != null && (
          <div
            className={`flex items-center gap-2 font-semibold tabular-nums ${urgency === "critical" ? "text-destructive" : urgency === "low" ? "text-warning" : "text-foreground"}`}
            aria-label={`Time left ${formatRemaining(remaining)}`}
          >
            <Timer className="w-4 h-4" aria-hidden />
            <span className="text-lg">{formatRemaining(remaining)}</span>
            <span className="text-xs font-medium text-muted-foreground">left</span>
          </div>
        )}
        <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} />
        <div className="text-sm text-muted-foreground ml-auto">
          {answeredCount} of {questions.length} answered
        </div>
      </div>
      {/* Screen readers hear warnings and connection changes without hunting for them. */}
      <div aria-live="polite" className="sr-only">{statusMessage}</div>
      {(saveState === "offline" || saveState === "error") && (
        <p role="status" className="text-sm flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3">
          <CloudOff className="w-4 h-4 mt-0.5 shrink-0 text-warning" aria-hidden />
          {statusMessage}
        </p>
      )}

      {questions.map((q: any, i: number) => (
        <Card key={q.id} className="shadow-sm">
          <CardContent className="p-5 md:p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold shrink-0" aria-hidden>{i + 1}</span>
                <div id={`q-${q.id}-prompt`} className="font-medium text-base md:text-lg">
                  <span className="sr-only">Question {i + 1}: </span>{q.prompt}
                </div>
              </div>
              <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-1 rounded shrink-0">
                {q.points} pt{q.points === 1 ? "" : "s"}
              </span>
            </div>

            {q.type === "multiple_choice" ? (
              <div role="radiogroup" aria-labelledby={`q-${q.id}-prompt`} className="space-y-2 md:pl-10">
                {(q.options ?? []).map((opt: string, oi: number) => {
                  const selected = answers[q.id]?.selectedOption === oi;
                  return (
                    <button
                      key={oi}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => update(q.id, { selectedOption: oi })}
                      className={`w-full flex items-center gap-3 p-3 min-h-11 border rounded-lg text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                    >
                      {selected ? <CheckCircle2 className="w-5 h-5 text-primary shrink-0" aria-hidden /> : <Circle className="w-5 h-5 text-muted-foreground shrink-0" aria-hidden />}
                      <span>{opt}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="md:pl-10">
                <Textarea
                  aria-labelledby={`q-${q.id}-prompt`}
                  placeholder="Type your answer…"
                  rows={4}
                  value={answers[q.id]?.textAnswer ?? ""}
                  onChange={(e) => update(q.id, { textAnswer: e.target.value })}
                />
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-muted/20 border rounded-xl px-4 md:px-6 py-4">
        <span className="text-sm text-muted-foreground">
          {unanswered > 0 ? `${unanswered} question${unanswered === 1 ? "" : "s"} unanswered` : "All questions answered"}
          {" · "}You can submit only once.
        </span>
        <Button
          type="button"
          size="lg"
          onClick={() => setConfirmOpen(true)}
          disabled={createAttempt.isPending}
          className="font-semibold px-8 w-full sm:w-auto shrink-0"
        >
          {createAttempt.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Submit quiz
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit your answers?</AlertDialogTitle>
            <AlertDialogDescription>
              {unanswered > 0
                ? `You have ${unanswered} unanswered question${unanswered === 1 ? "" : "s"}. `
                : ""}
              After you submit you cannot change your answers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working</AlertDialogCancel>
            <AlertDialogAction onClick={() => submit(false)}>Submit</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SaveIndicator({ state, lastSavedAt }: { state: SaveState; lastSavedAt: Date | null }) {
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Saving…
      </span>
    );
  }
  if (state === "offline" || state === "error") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-warning font-medium">
        <CloudOff className="w-3.5 h-3.5" aria-hidden /> Not saved yet — kept on this device
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Cloud className="w-3.5 h-3.5" aria-hidden />
      {lastSavedAt ? `All answers saved · ${format(lastSavedAt, "h:mm:ss a")}` : "Answers save automatically"}
    </span>
  );
}

import type { AskQuestion } from "@amc/shared";

/**
 * Claude Code built-ins that are really questions for the human, not tool
 * permissions. Their PermissionRequest is answered with data, not just allow/deny:
 * AskUserQuestion wants `updatedInput.answers`, ExitPlanMode is approve or keep planning.
 */
export const ASK_TOOL = "AskUserQuestion";
export const PLAN_TOOL = "ExitPlanMode";
export const PLAN_APPROVE = "Approve";
/** Mirrors Claude Code's own "Yes, and auto-accept edits": approve and switch the session to acceptEdits. */
export const PLAN_APPROVE_ACCEPT_EDITS = "Approve + auto-accept edits";
export const PLAN_KEEP = "Keep planning";

/** A UI build briefly used "Approve, auto-accept edits"; accept it as the same answer. */
export function canonicalPlanAnswer(answer: string): string {
  return answer.trim() === "Approve, auto-accept edits" ? PLAN_APPROVE_ACCEPT_EDITS : answer;
}

/**
 * Claude sees a deny message as a raw is_error tool result. Unframed operator
 * text read as a prompt injection in testing (Haiku refused after 3 loops), so
 * every message is phrased as the user's own feedback and never mentions the
 * hub or the gate.
 */
export function keepPlanningMessage(note: string | undefined): string {
  return note?.trim()
    ? `The user reviewed your plan and wants changes before you start: ${note.trim()}`
    : "The user reviewed your plan and wants you to keep planning before making changes.";
}

export function permissionDenyMessage(tool: string, note: string | undefined): string {
  return note?.trim()
    ? `The user declined this ${tool} call: ${note.trim()}`
    : `The user declined this ${tool} call.`;
}

export type Answers = Record<string, string | string[]>;

/** AskUserQuestion's tool_input.questions, validated; undefined if it is not usable. */
export function parseQuestions(input: unknown): AskQuestion[] | undefined {
  const raw = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") return undefined;
    const { question, header, options, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== "string" || !question.trim() || !Array.isArray(options)) {
      return undefined;
    }
    out.push({
      question,
      header: typeof header === "string" ? header : "",
      options: options
        .filter((o): o is Record<string, unknown> => !!o && typeof o.label === "string")
        .map((o) => ({
          label: o.label as string,
          ...(typeof o.description === "string" ? { description: o.description } : {}),
          ...(typeof o.preview === "string" ? { preview: o.preview } : {}),
        })),
      multiSelect: multiSelect === true,
    });
  }
  return out;
}

/**
 * Turns what the UI sent into the `answers` object Claude Code expects: one
 * entry per question text, a string (label or free text) or, for multiSelect,
 * an array of labels. Unknown keys are dropped. An older client that only sends
 * `answer` gets it mapped onto the first question, which covers single-question
 * calls; multi-question calls then need `answers`.
 */
export function normalizeAnswers(
  questions: AskQuestion[],
  answers: Answers | undefined,
  answer: string | undefined,
): { ok: true; answers: Answers } | { ok: false; error: string } {
  const given: Answers =
    answers && typeof answers === "object" && Object.keys(answers).length > 0
      ? answers
      : answer?.trim() && questions[0]
        ? { [questions[0].question]: answer.trim() }
        : {};
  const out: Answers = {};
  for (const q of questions) {
    const v = given[q.question];
    if (Array.isArray(v)) {
      const picks = v.filter((x): x is string => typeof x === "string" && !!x.trim());
      if (picks.length === 0) return { ok: false, error: `no answer for "${q.question}"` };
      // A single-select question takes one value; an array of one is fine too.
      out[q.question] = q.multiSelect ? picks : (picks[0] as string);
    } else if (typeof v === "string" && v.trim()) {
      out[q.question] = q.multiSelect ? [v.trim()] : v.trim();
    } else {
      return { ok: false, error: `no answer for "${q.question}"` };
    }
  }
  return { ok: true, answers: out };
}

/** "Scope: Hub; Tests: Unit + E2E" for log lines and Decision.answer. */
export function summariseAnswers(questions: AskQuestion[], answers: Answers): string {
  const one = (v: string | string[]) => (Array.isArray(v) ? v.join(" + ") : v);
  if (questions.length === 1 && questions[0]) return one(answers[questions[0].question] ?? "");
  return questions
    .map((q) => `${q.header || q.question}: ${one(answers[q.question] ?? "")}`)
    .join("; ");
}

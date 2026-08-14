/** @jsxImportSource react */
// Phase-0 question flow (durable json human requests rendered as forms, with
// the haiku prefetch queue surfaced), the refined-prompt approval editor, and
// the end-of-run poll form.
import { useMemo, useState } from "react";
import type { DelegationGraph } from "smthrs/gateway-react";
import {
  DcMarkdownEditor,
  goalApprovalTarget,
  isRecord,
  pendingQuestionSeqsOf,
  questionTarget,
  type DcActions,
  type DcPollAnswer,
  type DcQuestion,
} from "./dc-shared";

function optionsOf(question: DcQuestion): Array<{ label: string; description: string }> {
  const row = question as unknown as Record<string, unknown>;
  if (!Array.isArray(row.options)) return [];
  return row.options
    .filter(isRecord)
    .map((option) => ({
      label: typeof option.label === "string" ? option.label : "",
      description: typeof option.description === "string" ? option.description : "",
    }))
    .filter((option) => option.label.length > 0);
}

function recommendedBoolean(recommended: string): boolean {
  return /^(y|yes|true|approve|confirm)/i.test(recommended.trim());
}

export function QuestionForm({
  question,
  busy = false,
  disabled = false,
  onAnswer,
}: {
  question: DcQuestion;
  busy?: boolean;
  /** Blocks submit without the busy label (e.g. HumanTask not mounted yet). */
  disabled?: boolean;
  onAnswer: (value: unknown) => void;
}) {
  const options = optionsOf(question);
  const recommendedOption = options.find((option) => option.label === question.recommended);
  const [selected, setSelected] = useState<string>(recommendedOption?.label ?? options[0]?.label ?? "");
  const [confirmed, setConfirmed] = useState<boolean>(recommendedBoolean(question.recommended));
  const [text, setText] = useState<string>(question.kind === "text" ? question.recommended : "");

  const value: unknown = question.kind === "select" ? selected : question.kind === "confirm" ? confirmed : text;

  return (
    <div className="dc-section" data-testid={`dc-question-${question.seq}`}>
      <h3>{question.header || `Question ${question.seq}`}</h3>
      <p>{question.question}</p>
      {question.kind === "select" ? (
        <div className="dc-section" role="radiogroup">
          {options.map((option) => (
            <label
              key={option.label}
              className={"dc-option" + (selected === option.label ? " is-selected" : "")}
              data-testid={`dc-question-${question.seq}-option-${option.label}`}
            >
              <input
                type="radio"
                name={`dc-question-${question.seq}`}
                value={option.label}
                checked={selected === option.label}
                onChange={() => setSelected(option.label)}
              />
              <span>
                <span className="dc-option-label">{option.label}</span>
                {option.description ? <span className="dc-option-desc"> — {option.description}</span> : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {question.kind === "confirm" ? (
        <div className="dc-section" role="radiogroup">
          {[true, false].map((choice) => (
            <label
              key={String(choice)}
              className={"dc-option" + (confirmed === choice ? " is-selected" : "")}
              data-testid={`dc-question-${question.seq}-${choice ? "yes" : "no"}`}
            >
              <input
                type="radio"
                name={`dc-question-${question.seq}`}
                checked={confirmed === choice}
                onChange={() => setConfirmed(choice)}
              />
              <span className="dc-option-label">{choice ? "Yes" : "No"}</span>
            </label>
          ))}
        </div>
      ) : null}
      {question.kind === "text" ? (
        <textarea
          className="input"
          data-testid={`dc-question-${question.seq}-text`}
          value={text}
          onInput={(event) => setText(event.currentTarget.value)}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      ) : null}
      <div className="dc-question-reason">
        Recommended: <b>{question.recommended}</b>
        {question.reason ? <> — {question.reason}</> : null}
      </div>
      <button
        type="button"
        className="button primary"
        data-testid={`dc-question-${question.seq}-submit`}
        disabled={busy || disabled || (question.kind === "select" && !selected)}
        onClick={() => onAnswer(value)}
      >
        {busy ? "Submitting..." : "Answer"}
      </button>
    </div>
  );
}

/**
 * Lists pending questions in seq order: the first unresolved one is the live
 * form; the rest are the prefetched queue ("N more prepared" — haiku renders
 * form metadata ahead of the user). Prefetched rows exist BEFORE their
 * HumanTask mounts (question N's form only mounts after N-1 is answered), so
 * when `pendingApprovalIds` is provided, submit is only enabled once the
 * active question's own approval is actually pending — otherwise a submit
 * targets a not-yet-mounted form and errors.
 */
export function QuestionsPanel({
  questions,
  actions,
  pendingApprovalIds,
}: {
  questions: DcQuestion[];
  actions: Pick<DcActions, "answerHuman">;
  /**
   * Physical node ids with a pending human approval (useGatewayApprovals).
   * Omit (dev harnesses / older callers) to keep submits always enabled.
   */
  pendingApprovalIds?: ReadonlySet<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolved = useMemo(
    () => [...questions].filter((question) => !question.resolved).sort((a, b) => a.seq - b.seq),
    [questions],
  );
  if (unresolved.length === 0) return null;
  const [active, ...prepared] = unresolved;

  // The seq we are actually waiting on: an earlier question whose row has not
  // arrived yet (its approval is pending below the lowest existing row), or
  // the active row itself while its HumanTask has not mounted. null = the
  // active form is live and submittable.
  const activeTarget = questionTarget(active);
  const pendingSeqs = pendingApprovalIds === undefined ? null : pendingQuestionSeqsOf(pendingApprovalIds);
  const waitingForSeq =
    pendingSeqs === null
      ? null
      : pendingSeqs.length > 0 && pendingSeqs[0]! < active.seq
        ? pendingSeqs[0]!
        : pendingApprovalIds!.has(activeTarget.nodeId)
          ? null
          : active.seq;

  async function answer(question: DcQuestion, value: unknown) {
    setBusy(true);
    setError(null);
    try {
      const target = questionTarget(question);
      await actions.answerHuman(target.nodeId, target.iteration, value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card dc-questions" data-testid="dc-questions">
      <div className="card-head">
        <h3>Questions</h3>
        <span className="badge info" data-testid="dc-questions-prefetch">
          {prepared.length} more prepared
        </span>
      </div>
      <QuestionForm
        key={active.seq}
        question={active}
        busy={busy}
        disabled={waitingForSeq !== null}
        onAnswer={(value) => void answer(active, value)}
      />
      {waitingForSeq !== null ? (
        <span className="badge warn" data-testid="dc-question-waiting">
          waiting for question {waitingForSeq}…
        </span>
      ) : null}
      {error ? (
        <span className="badge bad" data-testid="dc-questions-error">
          {error}
        </span>
      ) : null}
      {prepared.length > 0 ? (
        <div className="dc-question-queue">
          {prepared.map((question) => (
            <span key={question.seq} className="chip" data-testid={`dc-question-queued-${question.seq}`}>
              {question.header || `Q${question.seq}`}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Full-width refined-prompt review: the prompt arrives as editable markdown;
 * Approve answers the goal approval human request with the (possibly edited)
 * prompt, Reject submits `{ approved: false, reason }` — the workflow contract
 * ENDS a rejected run. Renders even when the prompt is empty (degraded agent /
 * schema defaults): the editor shows with a warning so the paused run always
 * has something actionable. After a successful submit the buttons lock
 * ("Approved — planning starting…") so the residue panel (visible until the
 * first plan row arrives) cannot double-submit. Remount with
 * `key={graph.refinedPrompt ?? ""}` from the caller so a re-refined prompt
 * reseeds the editor.
 */
export function RefinedPromptApproval({
  graph,
  actions,
}: {
  graph: DelegationGraph;
  actions: Pick<DcActions, "answerHuman">;
}) {
  const initial = graph.refinedPrompt ?? "";
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<"approved" | "rejected" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  async function submit(value: unknown, outcome: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      const target = goalApprovalTarget(graph);
      await actions.answerHuman(target.nodeId, target.iteration, value);
      setSubmitted(outcome);
      setRejecting(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card dc-refined" data-testid="dc-refined-prompt">
      <div className="card-head">
        <h3>Refined prompt</h3>
        <span
          className={"badge " + (submitted === "approved" ? "ok" : submitted === "rejected" ? "bad" : "warn")}
          data-testid="dc-refined-status"
        >
          {submitted === "approved"
            ? "approved"
            : submitted === "rejected"
              ? "rejected — run ends"
              : "awaiting approval"}
        </span>
      </div>
      {initial === "" && submitted === null ? (
        <div className="dc-banner-bad" data-testid="dc-refined-empty">
          agent returned no refined prompt — write or reject
        </div>
      ) : null}
      <DcMarkdownEditor value={initial} resetKey="dc-refined-prompt" onChange={setDraft} />
      <div className="dc-editor-actions">
        <button
          type="button"
          className="button primary"
          data-testid="dc-refined-approve"
          disabled={busy || submitted !== null || !draft.trim()}
          onClick={() => void submit({ approved: true, refinedPrompt: draft }, "approved")}
        >
          {submitted === "approved" ? "Approved — planning starting…" : busy ? "Submitting..." : "Approve"}
        </button>
        {submitted === null ? (
          <button
            type="button"
            className="button danger"
            data-testid="dc-refined-reject-toggle"
            disabled={busy}
            onClick={() => setRejecting((current) => !current)}
          >
            Reject…
          </button>
        ) : null}
        {submitted === "rejected" ? (
          <span className="badge bad" data-testid="dc-refined-rejected">
            Rejected — the run ends here
          </span>
        ) : null}
        {error ? (
          <span className="badge bad" data-testid="dc-refined-error">
            {error}
          </span>
        ) : null}
      </div>
      {rejecting && submitted === null ? (
        <div className="dc-section" data-testid="dc-refined-reject">
          <p className="muted">Rejecting ends the run — the workflow stops here instead of planning.</p>
          <textarea
            className="input"
            data-testid="dc-refined-reject-reason"
            placeholder="Why reject? (recorded on the decision)"
            value={reason}
            onInput={(event) => setReason(event.currentTarget.value)}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <div className="dc-editor-actions">
            <button
              type="button"
              className="button danger"
              data-testid="dc-refined-reject-confirm"
              disabled={busy}
              onClick={() =>
                void submit(
                  { approved: false, refinedPrompt: draft, reason: reason.trim() || "rejected by human" },
                  "rejected",
                )
              }
            >
              {busy ? "Submitting..." : "Reject & end run"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// End-of-run poll: the last attention badge in the graph.
// ---------------------------------------------------------------------------

export const DEFAULT_POLL_QUESTIONS = [
  "Did the delegation plan match your intent?",
  "How useful were the previews and probes?",
  "Rate the quality of the final result.",
];

const RATINGS: DcPollAnswer["rating"][] = [1, 2, 3, 4, 5];

export function PollForm({
  questions = DEFAULT_POLL_QUESTIONS,
  busy = false,
  onSubmit,
}: {
  questions?: string[];
  busy?: boolean;
  onSubmit: (answers: DcPollAnswer[], comment?: string) => void;
}) {
  const [ratings, setRatings] = useState<Record<string, DcPollAnswer["rating"]>>({});
  const [comment, setComment] = useState("");
  const complete = questions.every((question) => ratings[question] !== undefined);

  return (
    <section className="card dc-poll" data-testid="dc-poll">
      <div className="card-head">
        <h3>How did this run go?</h3>
        <span className="badge warn">⚠ poll</span>
      </div>
      {questions.map((question, index) => (
        <div className="dc-poll-row" key={question}>
          <span className="dc-poll-q">{question}</span>
          <span className="dc-poll-ratings">
            {RATINGS.map((rating) => (
              <button
                key={rating}
                type="button"
                className={"dc-poll-rating" + (ratings[question] === rating ? " is-selected" : "")}
                data-testid={`dc-poll-rating-${index}-${rating}`}
                onClick={() => setRatings((current) => ({ ...current, [question]: rating }))}
              >
                {rating}
              </button>
            ))}
          </span>
        </div>
      ))}
      <textarea
        className="input"
        data-testid="dc-poll-comment"
        placeholder="Anything else? (optional)"
        value={comment}
        onInput={(event) => setComment(event.currentTarget.value)}
        onChange={(event) => setComment(event.currentTarget.value)}
      />
      <button
        type="button"
        className="button primary"
        data-testid="dc-poll-submit"
        disabled={busy || !complete}
        onClick={() =>
          onSubmit(
            questions.map((question) => ({ question, rating: ratings[question] as DcPollAnswer["rating"] })),
            comment.trim() || undefined,
          )
        }
      >
        {busy ? "Submitting..." : "Submit poll"}
      </button>
    </section>
  );
}

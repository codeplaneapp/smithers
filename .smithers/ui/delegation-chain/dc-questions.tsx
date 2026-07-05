/** @jsxImportSource react */
// Phase-0 question flow (durable json human requests rendered as forms, with
// the haiku prefetch queue surfaced), the refined-prompt approval editor, and
// the end-of-run poll form.
import { useMemo, useState } from "react";
import type { DelegationGraph } from "smithers-orchestrator/gateway-react";
import {
  DcMarkdownEditor,
  goalApprovalTarget,
  isRecord,
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
  onAnswer,
}: {
  question: DcQuestion;
  busy?: boolean;
  onAnswer: (value: unknown) => void;
}) {
  const options = optionsOf(question);
  const recommendedOption = options.find((option) => option.label === question.recommended);
  const [selected, setSelected] = useState<string>(recommendedOption?.label ?? options[0]?.label ?? "");
  const [confirmed, setConfirmed] = useState<boolean>(recommendedBoolean(question.recommended));
  const [text, setText] = useState<string>(question.kind === "text" ? question.recommended : "");

  const value: unknown =
    question.kind === "select" ? selected : question.kind === "confirm" ? confirmed : text;

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
        disabled={busy || (question.kind === "select" && !selected)}
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
 * form metadata ahead of the user).
 */
export function QuestionsPanel({
  questions,
  actions,
}: {
  questions: DcQuestion[];
  actions: Pick<DcActions, "answerHuman">;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolved = useMemo(
    () => [...questions].filter((question) => !question.resolved).sort((a, b) => a.seq - b.seq),
    [questions],
  );
  if (unresolved.length === 0) return null;
  const [active, ...prepared] = unresolved;

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
      <QuestionForm key={active.seq} question={active} busy={busy} onAnswer={(value) => void answer(active, value)} />
      {error ? <span className="badge bad" data-testid="dc-questions-error">{error}</span> : null}
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
 * prompt. Remount with `key={graph.refinedPrompt}` from the caller so a
 * re-refined prompt reseeds the editor.
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
  if (!initial) return null;

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const target = goalApprovalTarget(graph);
      await actions.answerHuman(target.nodeId, target.iteration, { approved: true, refinedPrompt: draft });
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
        <span className="badge warn">awaiting approval</span>
      </div>
      <DcMarkdownEditor value={initial} resetKey="dc-refined-prompt" onChange={setDraft} />
      <div className="dc-editor-actions">
        <button type="button" className="button primary" data-testid="dc-refined-approve" disabled={busy} onClick={() => void approve()}>
          {busy ? "Submitting..." : "Approve"}
        </button>
        {error ? <span className="badge bad">{error}</span> : null}
      </div>
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

/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { formatStatus, statusClass, statusLabels, useDialogFocusTrap, type FeatureStatus } from "./ddd-shared";

/**
 * First-launch guided tutorial, told over a canned hello-world app so the user
 * learns the mechanics on something tiny before touching their real spec.
 *
 * Persistence: localStorage when available. In multi the workflow UI runs in a
 * sandboxed iframe with an opaque origin (no storage); there the host page owns
 * persistence and passes ?tutorial=off once its own tutorial completes, so the
 * try/catch fallback below only affects the first session.
 */
const TUTORIAL_DONE_KEY = "ddd.tutorial.done";

export function tutorialStorageAvailable(): boolean {
  try {
    const probe = "__ddd_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function tutorialDone(): boolean {
  try {
    return window.localStorage.getItem(TUTORIAL_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTutorialDone(): void {
  try {
    window.localStorage.setItem(TUTORIAL_DONE_KEY, "1");
  } catch {
    // Opaque-origin iframe: the host page persists instead (?tutorial=off).
  }
}

/** True when the page was opened with ?tutorial=off (host-managed state). */
export function tutorialDisabledByUrl(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get("tutorial") === "off";
}

export function shouldShowTutorial(): boolean {
  return !tutorialDisabledByUrl() && !tutorialDone();
}

const HELLO_FEATURE = `{
  "id": "greet",
  "title": "Greet the user",
  "summary": "hello-world prints a personal greeting.",
  "status": "partial",
  "priority": "p0",
  "owner": "you",
  "tests": ["bun test greet.test.ts"],
  "missing": ["Greeting ignores the --name flag"]
}`;

type TutorialStep = {
  title: string;
  body: string;
  sample?: string;
  hint: string;
};

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: "Docs drive the development",
    body:
      "This app maintains a living spec of your product and puts agents to work closing the gaps in it. " +
      "Meet hello-world, a one-feature app we'll use to show how. Its whole spec is one feature record:",
    sample: HELLO_FEATURE,
    hint: "The Features tab renders records like this one as your product's status matrix.",
  },
  {
    title: "Status must be earned",
    body:
      'hello-world\'s feature is "partial", not "fixed", because its missing[] list still names a real gap. ' +
      "A feature only becomes fixed when the evidence (tests that exist and pass) proves it. " +
      "Agents are held to that: they make statuses more true, never more optimistic.",
    hint: "The Audit tab shows what the last audit found: broken, partial, and untested features.",
  },
  {
    title: "Edit docs, dispatch agents",
    body:
      "The Docs tab is a WYSIWYG editor over your product docs. Change the hello-world overview to say " +
      '"greeting supports --name" and hit Dispatch: a workflow run picks up your docs change, triages it ' +
      "against the code, and implements it. Docs first, code follows.",
    hint: "Only the product docs are yours to edit. Low-level generated docs live behind the Technical docs menu; ask your agent to read those.",
  },
  {
    title: "Tickets come from gaps",
    body:
      "Every missing[] entry becomes a ticket automatically, and the async bug scan files tickets for " +
      "verified bugs it finds in your code. hello-world would start with one ticket: the --name flag bug.",
    hint: "The Tickets tab is the backlog. Agents burn it down round after round.",
  },
  {
    title: "Watch it live",
    body:
      "The Live tab streams the running workflow: every audit, triage decision, implementation, and review " +
      "as it happens. Nothing here is faked; if a run is not connected you'll see exactly that. " +
      "That's the whole loop. Now it's your product's turn.",
    hint: "Reopen this tour anytime with the ? button in the header.",
  },
];

/**
 * The hello-world feature record rendered the way the Features tab renders it —
 * a card with a status badge, priority/owner pills, a tests chip, and a
 * missing-gap warning — so step 1 teaches with UI, not a raw-JSON <pre>. The
 * raw record stays available behind "View source".
 */
function SampleFeatureCard({ json }: { json: string }) {
  let record: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
  } catch {
    return <pre className="code tutorial-sample">{json}</pre>;
  }
  const status = String(record.status ?? "");
  const title = String(record.title ?? record.id ?? "Feature");
  const summary = String(record.summary ?? "");
  const priority = String(record.priority ?? "");
  const owner = String(record.owner ?? "");
  const tests = Array.isArray(record.tests) ? record.tests.map(String) : [];
  const missing = Array.isArray(record.missing) ? record.missing.map(String) : [];
  return (
    <div className="tutorial-sample-card" data-testid="ddd-tutorial-sample-card">
      <div className="feature-card">
        <div className="feature-card-head">
          <strong>{title}</strong>
          {status ? (
            <span className={`badge ${statusClass(status)}`}>
              {statusLabels[status as FeatureStatus] ?? formatStatus(status)}
            </span>
          ) : null}
        </div>
        {summary ? <p className="feature-card-summary">{summary}</p> : null}
        <div className="feature-card-foot">
          {priority ? <span className="pill muted">P{priority.replace(/^p/i, "")}</span> : null}
          {owner ? <span className="pill">Owner {owner}</span> : null}
          {tests.length ? (
            <span className="pill">{tests.length === 1 ? "1 test" : `${tests.length} tests`}</span>
          ) : null}
        </div>
        {missing.length ? (
          <div className="tutorial-sample-gap">
            <span className="badge warn">Open gap</span>
            <span>{missing[0]}</span>
          </div>
        ) : null}
      </div>
      <details className="tutorial-sample-source">
        <summary>View source</summary>
        <pre className="code tutorial-sample">{json}</pre>
      </details>
    </div>
  );
}

export function Tutorial({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const cardRef = useRef<HTMLElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  function finish() {
    markTutorialDone();
    setStep(0);
    onClose();
  }

  useDialogFocusTrap({ active: open, containerRef: cardRef, initialFocusRef: nextRef, onClose: finish });

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => nextRef.current?.focus());
  }, [open]);

  if (!open) return null;
  const current = TUTORIAL_STEPS[Math.min(step, TUTORIAL_STEPS.length - 1)]!;
  const last = step >= TUTORIAL_STEPS.length - 1;

  return (
    <div className="tutorial-backdrop" data-testid="ddd-tutorial" role="presentation" onClick={finish}>
      <section
        ref={cardRef}
        className="tutorial-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddd-tutorial-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tutorial-head">
          <span className="eyebrow">Guided tour · hello-world</span>
          <div className="tutorial-head-actions">
            <span className="pill">
              {step + 1} / {TUTORIAL_STEPS.length}
            </span>
            <button type="button" className="icon-button" aria-label="Close tutorial" onClick={finish}>
              x
            </button>
          </div>
        </div>
        <h2 id="ddd-tutorial-title" className="tutorial-title">
          {current.title}
        </h2>
        <p className="tutorial-body">{current.body}</p>
        {current.sample ? <SampleFeatureCard json={current.sample} /> : null}
        <p className="tutorial-hint">{current.hint}</p>
        <div className="tutorial-actions">
          <button type="button" className="button" data-testid="ddd-tutorial-skip" onClick={finish}>
            Skip tour
          </button>
          <div className="tutorial-steps-nav">
            <button
              type="button"
              className="button"
              disabled={step === 0}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              Back
            </button>
            <button
              ref={nextRef}
              type="button"
              className="button primary"
              data-testid="ddd-tutorial-next"
              onClick={() => (last ? finish() : setStep((s) => s + 1))}
            >
              {last ? "Start building" : "Next"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

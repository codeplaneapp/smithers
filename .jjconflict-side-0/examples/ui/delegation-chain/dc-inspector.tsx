/** @jsxImportSource react */
// Node inspector side panel: brief, preview (with the never-executed warning),
// probe reports, the live-editable output (Crepe WYSIWYG via DcMarkdownEditor —
// saving submits a dc-edit signal and the workflow answers with an
// invalidation round), and the full version history including archived
// (invalidated) states.
import { useEffect, useState } from "react";
import {
  DcMarkdownEditor,
  EstimateChip,
  MarkdownPreview,
  asString,
  devPreviewOf,
  formatUsd,
  gateLabel,
  gateTitle,
  isRecord,
  outputToMarkdown,
  type DcActions,
  type DcVersion,
  type DelegationNode,
} from "./dc-shared";

// ---------------------------------------------------------------------------
// Defensive readers for archived version rows. The row payloads are owned by
// the packages/components zod schemas; read structurally so a partially-folded
// or older row never crashes the inspector.
// ---------------------------------------------------------------------------

type PlanChild = { logicalId: string; tier: string; kind: string; title: string };
type PlanRisk = { id: string; description: string; probe: string | null; reason: string };

function planOf(value: unknown): { title: string; brief: string; children: PlanChild[]; risks: PlanRisk[] } | null {
  if (!isRecord(value)) return null;
  const children = Array.isArray(value.children)
    ? value.children.filter(isRecord).map((child) => ({
        logicalId: asString(child.logicalId),
        tier: asString(child.tier),
        kind: asString(child.kind),
        title: asString(child.title),
      }))
    : [];
  const risks = Array.isArray(value.risks)
    ? value.risks.filter(isRecord).map((risk) => ({
        id: asString(risk.id),
        description: asString(risk.description),
        probe: typeof risk.probe === "string" ? risk.probe : null,
        reason: asString(risk.reason),
      }))
    : [];
  return { title: asString(value.title), brief: asString(value.brief), children, risks };
}

export type DcCommitRange = { from: string; to: string; vcs: "jj" | "git" };

function commitRangeOf(value: unknown): DcCommitRange | null {
  if (!isRecord(value)) return null;
  if (typeof value.from !== "string" || typeof value.to !== "string" || !value.from || !value.to) return null;
  return { from: value.from, to: value.to, vcs: value.vcs === "git" ? "git" : "jj" };
}

function execAttemptsOf(value: unknown): Array<{
  attempt: number;
  summary: string;
  artifacts: string[];
  costUsd: number | null;
  commitRange: DcCommitRange | null;
}> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    attempt: typeof row.attempt === "number" ? row.attempt : 0,
    summary: asString(row.summary),
    artifacts: Array.isArray(row.artifacts) ? row.artifacts.filter((a): a is string => typeof a === "string") : [],
    costUsd: isRecord(row.actual) && typeof row.actual.costUsd === "number" ? row.actual.costUsd : null,
    commitRange: commitRangeOf(row.commitRange),
  }));
}

/** Compact monospace `jj 1a2b3c..4d5e6f` chip; clicking copies the full range. */
export function CommitRangeChip({ range, testId }: { range: DcCommitRange; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const fullRange = `${range.from}..${range.to}`;
  const shortHash = (hash: string) => hash.slice(0, 8);
  return (
    <button
      type="button"
      className="dc-commit-chip"
      data-testid={testId ?? "dc-commit-range"}
      title={`Copy ${fullRange} (${range.vcs})`}
      onClick={(event) => {
        event.stopPropagation();
        void (async () => {
          try {
            await navigator.clipboard.writeText(fullRange);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            setCopied(false);
          }
        })();
      }}
    >
      {copied ? "copied" : `${range.vcs} ${shortHash(range.from)}..${shortHash(range.to)}`}
    </button>
  );
}

function reviewAttemptsOf(value: unknown): Array<{ attempt: number; verdict: string; feedback: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    attempt: typeof row.attempt === "number" ? row.attempt : 0,
    verdict: asString(row.verdict),
    feedback: asString(row.feedback),
  }));
}

function invalidationOf(value: unknown): { round: number; reason: string; triggerType: string; triggerRef: string } | null {
  if (!isRecord(value)) return null;
  const trigger = isRecord(value.trigger) ? value.trigger : {};
  return {
    round: typeof value.round === "number" ? value.round : 0,
    reason: asString(value.reason),
    triggerType: asString(trigger.type),
    triggerRef: asString(trigger.ref),
  };
}

function gatesRowOf(value: unknown): DelegationNode["gates"] {
  if (!isRecord(value) || !Array.isArray(value.gates)) return [];
  return value.gates as DelegationNode["gates"];
}

function probeReportOf(output: unknown): { question: string; answer: string; report: string; planImpact: string } | null {
  if (!isRecord(output)) return null;
  const report = asString(output.report);
  const answer = asString(output.answer);
  if (!report && !answer) return null;
  return { question: asString(output.question), answer, report, planImpact: asString(output.planImpact) };
}

// ---------------------------------------------------------------------------

function VersionDetail({ entry, node }: { entry: DcVersion; node: DelegationNode }) {
  const isCurrent = entry.version === node.version;
  const plan = planOf(entry.plan);
  const gates = gatesRowOf(entry.gates);
  const execAttempts = execAttemptsOf(entry.exec);
  const reviewAttempts = reviewAttemptsOf(entry.review);
  const invalidation = invalidationOf(entry.invalidatedBy);
  return (
    <div className="dc-section" data-testid={`dc-version-detail-${entry.version}`}>
      {!isCurrent ? (
        <div className="dc-banner-muted" data-testid="dc-version-archived">
          Archived version v{entry.version} — superseded by v{node.version}
        </div>
      ) : null}
      {invalidation ? (
        <div className="dc-banner-bad" data-testid="dc-invalidated-by">
          Invalidated{invalidation.round ? ` (replan round ${invalidation.round})` : ""}: {invalidation.reason || "no reason recorded"}
          {invalidation.triggerType ? (
            <span className="mono"> [{invalidation.triggerType}{invalidation.triggerRef ? `: ${invalidation.triggerRef}` : ""}]</span>
          ) : null}
        </div>
      ) : null}
      {plan ? (
        <section className="dc-section" data-testid="dc-version-plan">
          <h3>Plan{plan.title ? ` — ${plan.title}` : ""}</h3>
          {plan.brief ? <MarkdownPreview markdown={plan.brief} /> : null}
          {plan.children.length > 0 ? (
            <div className="dc-score-grid">
              {plan.children.map((child) => (
                <div className="dc-score-row" key={child.logicalId}>
                  <span className="dc-score-key">{child.logicalId}</span>
                  <span className="dc-score-val">
                    {child.title} ({child.tier} {child.kind})
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {plan.risks.length > 0 ? (
            <div className="dc-score-grid">
              {plan.risks.map((risk) => (
                <div className="dc-score-row" key={risk.id || risk.description}>
                  <span className="dc-score-key">{risk.probe ? `probe:${risk.probe}` : "routine"}</span>
                  <span className="dc-score-val">{risk.description}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {gates.length > 0 ? (
        <section className="dc-section" data-testid="dc-version-gates">
          <h3>Gates</h3>
          <div className="dc-gates">
            {gates.map((gate, index) => (
              <span key={index} className={`dc-gate dc-gate-${gate.method}`} title={gateTitle(gate)}>
                {gateLabel(gate)}
              </span>
            ))}
          </div>
        </section>
      ) : null}
      {execAttempts.length > 0 ? (
        <section className="dc-section" data-testid="dc-version-exec">
          <h3>Execution attempts</h3>
          {execAttempts.map((attempt) => (
            <div className="dc-attempt" key={`exec-${attempt.attempt}`}>
              <div className="dc-attempt-head">
                <span className="badge">attempt {attempt.attempt}</span>
                {attempt.costUsd !== null ? <span className="dc-est">{formatUsd(attempt.costUsd)}</span> : null}
                {attempt.commitRange ? (
                  <CommitRangeChip range={attempt.commitRange} testId={`dc-commit-range-${attempt.attempt}`} />
                ) : null}
              </div>
              {attempt.summary ? <span>{attempt.summary}</span> : null}
              {attempt.artifacts.length > 0 ? (
                <span className="muted">{attempt.artifacts.join(", ")}</span>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {reviewAttempts.length > 0 ? (
        <section className="dc-section" data-testid="dc-version-review">
          <h3>Review attempts</h3>
          {reviewAttempts.map((attempt) => (
            <div className="dc-attempt" key={`review-${attempt.attempt}`}>
              <div className="dc-attempt-head">
                <span className="badge">attempt {attempt.attempt}</span>
                <span className={"badge " + (attempt.verdict === "pass" ? "ok" : "bad")} data-testid={`dc-review-verdict-${attempt.attempt}`}>
                  {attempt.verdict || "?"}
                </span>
              </div>
              {attempt.feedback ? <span>{attempt.feedback}</span> : null}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Developer preview panel (dcDevPreview): the post-execution backpressure
 * gate's artifact — html in a sandboxed iframe, url as a prominent open link,
 * markdown via MarkdownPreview — plus the two INHERENT affordances every
 * preview carries: [Request changes] and [Invalidate]. Both submit the SAME
 * dc-edit signal as a live output edit (output rides along unchanged; the
 * note carries the human intent), so the workflow answers with a replan round.
 */
export function DevPreviewPanel({
  node,
  actions,
}: {
  node: DelegationNode;
  actions: Pick<DcActions, "submitEdit">;
}) {
  const devPreview = devPreviewOf(node);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"request" | "invalidate" | null>(null);
  if (!devPreview) return null;

  async function send(note: string, kind: "request" | "invalidate") {
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      await actions.submitEdit(node.logicalId, node.output, note);
      setFeedback("");
      setConfirmation(kind);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dc-section" data-testid="dc-devpreview">
      <div className="dc-section-head">
        <h3>Developer preview{devPreview.title ? ` — ${devPreview.title}` : ""}</h3>
        <span className="dc-meta">
          <span className="badge info">{devPreview.kind}</span>
          <span className={"badge " + (devPreview.builtOk ? "ok" : "bad")} data-testid="dc-devpreview-built">
            {devPreview.builtOk ? "built" : "build failed — gate fails, node redelegates"}
          </span>
        </span>
      </div>
      {devPreview.summary ? <p>{devPreview.summary}</p> : null}
      {devPreview.artifact.type === "html" && devPreview.artifact.content !== undefined ? (
        <iframe
          className="dc-devpreview-frame"
          data-testid="dc-devpreview-html"
          sandbox="allow-scripts"
          srcDoc={devPreview.artifact.content}
          title={devPreview.title || `${node.logicalId} developer preview`}
        />
      ) : null}
      {devPreview.artifact.type === "url" && devPreview.artifact.url ? (
        <a
          className="dc-devpreview-link"
          data-testid="dc-devpreview-url"
          href={devPreview.artifact.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open {devPreview.kind} preview ↗ <span className="mono">{devPreview.artifact.url}</span>
        </a>
      ) : null}
      {devPreview.artifact.type === "markdown" && devPreview.artifact.content !== undefined ? (
        <div data-testid="dc-devpreview-markdown">
          <MarkdownPreview markdown={devPreview.artifact.content} />
        </div>
      ) : null}
      {devPreview.instructions ? (
        <pre className="dc-instructions" data-testid="dc-devpreview-instructions">
          {devPreview.instructions}
        </pre>
      ) : null}
      <textarea
        className="input"
        data-testid="dc-devpreview-feedback"
        placeholder="What should change? (drives the same replan round as an output edit)"
        value={feedback}
        onInput={(event) => setFeedback(event.currentTarget.value)}
        onChange={(event) => setFeedback(event.currentTarget.value)}
      />
      <div className="dc-editor-actions">
        <button
          type="button"
          className="button primary"
          data-testid="dc-devpreview-request-changes"
          disabled={busy || !feedback.trim()}
          onClick={() => void send(feedback.trim(), "request")}
        >
          Request changes
        </button>
        <button
          type="button"
          className="button danger"
          data-testid="dc-devpreview-invalidate"
          disabled={busy}
          onClick={() => void send(`invalidate: ${feedback.trim() || "rejected from developer preview"}`, "invalidate")}
        >
          Invalidate
        </button>
        {confirmation === "request" ? <span className="badge ok">change request sent</span> : null}
        {confirmation === "invalidate" ? <span className="badge warn">invalidation requested</span> : null}
        {error ? <span className="badge bad" data-testid="dc-devpreview-error">{error}</span> : null}
      </div>
    </section>
  );
}

export function NodeInspector({
  node,
  actions,
  onClose,
}: {
  node: DelegationNode;
  actions: Pick<DcActions, "submitEdit">;
  onClose?: () => void;
}) {
  // null = the current (live) version.
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    setSelectedVersion(null);
    setEditing(false);
    setNote("");
    setError(null);
  }, [node.logicalId]);

  const versionsSorted = [...node.versions].sort((a, b) => b.version - a.version);
  const activeVersion = selectedVersion ?? node.version;
  const activeEntry = versionsSorted.find((entry) => entry.version === activeVersion);
  const isCurrent = activeVersion === node.version;
  const outputMarkdown = outputToMarkdown(node.output);
  const isProbe = node.kind === "poc" || node.kind === "research";
  const probe = isProbe ? probeReportOf(node.output) : null;
  // The goal's output IS the approved refined prompt: editable only while the
  // approval is pending (awaiting-human). After approval it is the contract
  // the plan was built from — edits go to the plan nodes instead.
  const goalEditLocked = node.kind === "goal" && node.status !== "awaiting-human";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Live WYSIWYG edit → dc-edit signal → the workflow runs the same
      // bubble-up invalidation round as a probe finding; the graph updates
      // live through the hook.
      await actions.submitEdit(node.logicalId, draft, note.trim() || undefined);
      setEditing(false);
      setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card dc-inspector" data-testid="dc-inspector">
      <div className="card-head">
        <h2>{node.title || node.logicalId}</h2>
        {onClose ? (
          <button type="button" className="button" data-testid="dc-inspector-close" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
      <div className="dc-meta">
        <span className="pill mono">{node.logicalId}</span>
        <span className={`dc-tier dc-tier-${node.tier}`}>{node.tier}</span>
        <span className="dc-kind">{node.kind}</span>
        <span className={`dc-status dc-status-${node.status}`}>{node.status}</span>
        <EstimateChip node={node} />
      </div>

      <div className="dc-section">
        <div className="dc-section-head">
          <h3>Versions</h3>
        </div>
        <div className="dc-versions" data-testid="dc-versions">
          {versionsSorted.map((entry) => (
            <button
              key={entry.version}
              type="button"
              className={
                "dc-version-item" +
                (entry.version === activeVersion ? " is-active" : "") +
                (entry.invalidatedBy ? " is-invalidated" : "")
              }
              data-testid={`dc-version-${entry.version}`}
              onClick={() => setSelectedVersion(entry.version === node.version ? null : entry.version)}
            >
              v{entry.version}
              {entry.version === node.version ? " · current" : entry.invalidatedBy ? " ✕" : ""}
            </button>
          ))}
          {versionsSorted.length === 0 ? <span className="muted">v{node.version} · current</span> : null}
        </div>
      </div>

      {activeEntry ? <VersionDetail entry={activeEntry} node={node} /> : null}

      {isCurrent ? (
        <>
          {node.brief ? (
            <section className="dc-section" data-testid="dc-brief">
              <h3>Brief</h3>
              <MarkdownPreview markdown={node.brief} />
            </section>
          ) : null}

          {node.preview ? (
            <section className="dc-section" data-testid="dc-preview">
              <div className="dc-preview-banner" data-testid="dc-preview-banner">
                ⚠ NEVER EXECUTED — calibration only
              </div>
              <MarkdownPreview markdown={node.preview} />
            </section>
          ) : null}

          {probe ? (
            <section className="dc-section" data-testid="dc-probe-report">
              <div className="dc-section-head">
                <h3>Probe report (sourced)</h3>
                {probe.planImpact ? <span className="badge info">{probe.planImpact}</span> : null}
              </div>
              {probe.question ? <p className="muted">{probe.question}</p> : null}
              {probe.answer ? <p>{probe.answer}</p> : null}
              {probe.report ? <MarkdownPreview markdown={probe.report} /> : null}
            </section>
          ) : null}

          <DevPreviewPanel node={node} actions={actions} />

          {outputMarkdown !== null ? (
            <section className="dc-section" data-testid="dc-output">
              <div className="dc-section-head">
                <h3>{probe ? "Probe output (raw)" : "Output"}</h3>
                {!editing ? (
                  <button
                    type="button"
                    className="button"
                    data-testid="dc-edit-toggle"
                    disabled={goalEditLocked}
                    title={goalEditLocked ? "goal is locked after approval — edit the plan nodes instead" : undefined}
                    onClick={() => {
                      setDraft(outputMarkdown);
                      setResetKey((key) => key + 1);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                ) : null}
              </div>
              {isProbe ? (
                <span className="muted" data-testid="dc-probe-edit-hint">
                  edits to a probe replan its parent
                </span>
              ) : null}
              {goalEditLocked ? (
                <span className="muted" data-testid="dc-goal-edit-hint">
                  goal is locked after approval — edit the plan nodes instead
                </span>
              ) : null}
              {editing ? (
                <div className="dc-editor" data-testid="dc-editor">
                  <DcMarkdownEditor
                    value={outputMarkdown}
                    resetKey={`dc-edit-${node.logicalId}-${resetKey}`}
                    onChange={setDraft}
                  />
                  <input
                    className="input"
                    data-testid="dc-edit-note"
                    placeholder="Why this change? (optional note for the replan round)"
                    value={note}
                    onInput={(event) => setNote(event.currentTarget.value)}
                    onChange={(event) => setNote(event.currentTarget.value)}
                  />
                  <div className="dc-editor-actions">
                    <button type="button" className="button primary" data-testid="dc-edit-save" disabled={busy} onClick={() => void save()}>
                      {busy ? "Submitting..." : "Save & replan"}
                    </button>
                    <button
                      type="button"
                      className="button"
                      data-testid="dc-edit-cancel"
                      disabled={busy}
                      onClick={() => {
                        setEditing(false);
                        setError(null);
                      }}
                    >
                      Cancel
                    </button>
                    {error ? <span className="badge bad" data-testid="dc-edit-error">{error}</span> : null}
                  </div>
                </div>
              ) : probe ? null : (
                // Parsed probe rows already render as the sourced report above;
                // the raw row only shows here while editing.
                <MarkdownPreview markdown={outputMarkdown} />
              )}
            </section>
          ) : null}

          {outputMarkdown === null && !probe && !node.preview ? (
            <p className="muted" data-testid="dc-no-output">
              No output yet — it becomes editable here the moment it lands.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** @jsxImportSource react */
// Shared model + small components for the delegation-chain UI (dc-*).
// Everything here is either a pure function or a gateway-free component so bun
// tests can exercise it directly (no network, no ReactFlow canvas required).
// The DelegationGraph shape is the frozen contract owned by
// smithers-orchestrator/gateway-react (useDelegationChain / foldDelegation).
import { Suspense, lazy, useState, type ReactNode } from "react";
import type { DelegationGraph } from "smithers-orchestrator/gateway-react";

export type DelegationNode = DelegationGraph["nodes"][string];
export type DcGate = DelegationNode["gates"][number];
export type DcVersion = DelegationNode["versions"][number];
export type DcEstimate = NonNullable<DelegationGraph["budget"]["predicted"]>;
export type DcBudget = DelegationGraph["budget"];
export type DcQuestion = DelegationGraph["pendingQuestions"][number];
export type DcPhase = DelegationGraph["phase"];
export type DcTier = DelegationNode["tier"];
export type DcPollAnswer = { question: string; rating: 1 | 2 | 3 | 4 | 5 };

/**
 * Structural mirror of `useDelegationChain().actions` (frozen contract). The
 * real actions object is assignable to this; components depend on this type so
 * tests can inject plain fake functions at the component seam.
 */
export type DcActions = {
  submitEdit: (logicalId: string, editedOutput: unknown, note?: string) => Promise<void>;
  skipPreviews: () => Promise<void>;
  answerHuman: (nodeId: string, iteration: number, value: unknown) => Promise<void>;
  submitPoll: (answers: DcPollAnswer[], comment?: string) => Promise<void>;
};

export const DC_PHASES: DcPhase[] = [
  "goal",
  "planning",
  "preview",
  "gates",
  "derisk",
  "execution",
  "scoring",
  "done",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function attentionCount(node: Pick<DelegationNode, "attention">): number {
  return (node.attention.self ? 1 : 0) + node.attention.descendants;
}

// Gate helpers read structurally so the newer `preview` gate method (a
// REQUIRED post-execution developer-preview gate) renders even while the
// gateway-react Gate union catches up to the contract.
export function gateLabel(gate: DcGate): string {
  const row = gate as unknown as { method: string; tier?: string; kind?: string };
  if (row.method === "review") return `review·${row.tier}`;
  if (row.method === "check") return "check";
  if (row.method === "preview") return `preview·${row.kind}`;
  return "approval";
}
export function gateTitle(gate: DcGate): string {
  const row = gate as unknown as { method: string; brief?: string; command?: string; policyMatch?: string };
  if (row.method === "review" || row.method === "preview") return row.brief ?? "";
  if (row.method === "check") return row.command ?? "";
  return row.policyMatch ?? "";
}

// ---------------------------------------------------------------------------
// Developer preview (dcDevPreview → node.devPreview): a REQUIRED backpressure
// gate that runs after the node executes. Read via a structural guard — the
// fold in gateway-react is landing in parallel, and this also tolerates
// partially-folded rows.
// ---------------------------------------------------------------------------

export type DcDevPreviewKind = "app" | "terminal" | "api" | "throwaway-ui" | "slideshow";
export type DcDevPreview = {
  kind: DcDevPreviewKind;
  title: string;
  /** false fails the gate like a failed review — the node redelegates. */
  builtOk: boolean;
  artifact: { type: "html" | "url" | "markdown"; content?: string; url?: string };
  instructions?: string;
  summary: string;
};

const DEV_PREVIEW_KINDS: readonly string[] = ["app", "terminal", "api", "throwaway-ui", "slideshow"];

export function devPreviewOf(node: DelegationNode): DcDevPreview | null {
  const raw = (node as unknown as Record<string, unknown>).devPreview;
  if (!isRecord(raw)) return null;
  const artifact = isRecord(raw.artifact) ? raw.artifact : null;
  if (!artifact) return null;
  const type = artifact.type;
  if (type !== "html" && type !== "url" && type !== "markdown") return null;
  const kind = DEV_PREVIEW_KINDS.includes(raw.kind as string) ? (raw.kind as DcDevPreviewKind) : "app";
  return {
    kind,
    title: asString(raw.title),
    builtOk: raw.builtOk !== false,
    artifact: {
      type,
      content: typeof artifact.content === "string" ? artifact.content : undefined,
      url: typeof artifact.url === "string" ? artifact.url : undefined,
    },
    instructions: typeof raw.instructions === "string" ? raw.instructions : undefined,
    summary: asString(raw.summary),
  };
}

/** Markdown rendering source for an arbitrary node output. */
export function outputToMarkdown(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  if (typeof output === "string") return output;
  return "```json\n" + JSON.stringify(output, null, 2) + "\n```";
}

export function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

export function ErrorBanner({ title, errors }: { title: string; errors: unknown[] }) {
  if (errors.length === 0) return null;
  return (
    <section className="dc-error-banner" role="alert" data-testid="dc-error-banner">
      <strong>{title}</strong>
      {errors.map((error, index) => (
        <span key={index}>{error instanceof Error ? error.message : String(error)}</span>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Lightweight MarkdownPreview — adapted (trimmed) from the DDD shared UI's
// parseMarkdownBlocks/renderInlineMarkdown: no mermaid rendering (```mermaid
// fences stay plain code blocks) and no in-spec link routing, keeping the
// seeded init-pack import closure small.
// ---------------------------------------------------------------------------

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; lang: string; code: string };

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(/^>\s?(.*)$/);
        if (!match) break;
        quoted.push(match[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "quote", text: quoted.join("\n").trim() });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.test(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.test(line);
    if (bullet || ordered) {
      const items: string[] = [];
      const pattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(pattern);
        if (!match) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim()) break;
      if (/^```/.test(next) || /^#{1,6}\s+/.test(next) || /^>\s?/.test(next) || /^\s*[-*]\s+/.test(next) || /^\s*\d+\.\s+/.test(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function markdownEscaped(value: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function findUnescaped(value: string, token: string, start: number): number {
  let index = value.indexOf(token, start);
  while (index >= 0) {
    if (!markdownEscaped(value, index)) return index;
    index = value.indexOf(token, index + token.length);
  }
  return -1;
}

function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\\`*_[\]{}()#+\-.!<>|])/g, "$1");
}

function renderInlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) nodes.push(unescapeMarkdownText(value.slice(textStart, end)));
  };
  while (cursor < value.length) {
    if (value[cursor] === "`" && !markdownEscaped(value, cursor)) {
      const end = findUnescaped(value, "`", cursor + 1);
      if (end > cursor) {
        flushText(cursor);
        nodes.push(<code key={`${keyPrefix}:code:${cursor}`}>{value.slice(cursor + 1, end).replace(/\\`/g, "`")}</code>);
        cursor = end + 1;
        textStart = cursor;
        continue;
      }
    }
    if (value.startsWith("**", cursor) && !markdownEscaped(value, cursor)) {
      const end = findUnescaped(value, "**", cursor + 2);
      if (end > cursor) {
        flushText(cursor);
        nodes.push(
          <strong key={`${keyPrefix}:strong:${cursor}`}>
            {renderInlineMarkdown(value.slice(cursor + 2, end), `${keyPrefix}:strong:${cursor}`)}
          </strong>,
        );
        cursor = end + 2;
        textStart = cursor;
        continue;
      }
    }
    if (value[cursor] === "*" && !markdownEscaped(value, cursor)) {
      const end = findUnescaped(value, "*", cursor + 1);
      if (end > cursor + 1) {
        flushText(cursor);
        nodes.push(
          <em key={`${keyPrefix}:em:${cursor}`}>
            {renderInlineMarkdown(value.slice(cursor + 1, end), `${keyPrefix}:em:${cursor}`)}
          </em>,
        );
        cursor = end + 1;
        textStart = cursor;
        continue;
      }
    }
    if (value[cursor] === "[" && !markdownEscaped(value, cursor)) {
      const labelEnd = findUnescaped(value, "]", cursor + 1);
      if (labelEnd > cursor && value[labelEnd + 1] === "(") {
        const hrefEnd = findUnescaped(value, ")", labelEnd + 2);
        if (hrefEnd > labelEnd) {
          flushText(cursor);
          const label = value.slice(cursor + 1, labelEnd);
          const href = unescapeMarkdownText(value.slice(labelEnd + 2, hrefEnd));
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith("mailto:")) {
            nodes.push(
              <a key={`${keyPrefix}:link:${cursor}`} className="doc-link" href={href} target="_blank" rel="noreferrer">
                {renderInlineMarkdown(label, `${keyPrefix}:link-label:${cursor}`)}
              </a>,
            );
          } else {
            // No in-spec doc routing in this trimmed preview.
            nodes.push(
              <span key={`${keyPrefix}:link:${cursor}`} className="doc-link">
                {unescapeMarkdownText(label)}
              </span>,
            );
          }
          cursor = hrefEnd + 1;
          textStart = cursor;
          continue;
        }
      }
    }
    cursor += 1;
  }
  flushText(value.length);
  return nodes;
}

export function MarkdownPreview({ markdown }: { markdown: string }) {
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) return <p className="muted">Nothing to display.</p>;
  return (
    <div className="markdown-preview" data-testid="dc-markdown-preview">
      {blocks.map((block, index) => {
        const key = `md:${index}`;
        if (block.type === "heading") {
          if (block.level <= 1) return <h1 key={key}>{renderInlineMarkdown(block.text, key)}</h1>;
          if (block.level === 2) return <h2 key={key}>{renderInlineMarkdown(block.text, key)}</h2>;
          return <h3 key={key}>{renderInlineMarkdown(block.text, key)}</h3>;
        }
        if (block.type === "quote") return <blockquote key={key}>{renderInlineMarkdown(block.text, key)}</blockquote>;
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}:item:${itemIndex}`}>{renderInlineMarkdown(item, `${key}:item:${itemIndex}`)}</li>
              ))}
            </List>
          );
        }
        if (block.type === "code") {
          // Mermaid fences stay plain code blocks by design (no mermaid dep).
          return (
            <pre key={key} className="markdown-code">
              <code>{block.code}</code>
            </pre>
          );
        }
        return <p key={key}>{renderInlineMarkdown(block.text, key)}</p>;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown editor: the cw-editor Crepe WYSIWYG in real browsers; a plain
// textarea in DOM-less test environments (same sniff the DDD editor used).
// Lazy so @milkdown/crepe is only imported in a real browser.
// ---------------------------------------------------------------------------

const CrepeMarkdownEditor = lazy(() =>
  import("./cw-editor").then((module) => ({ default: module.MarkdownEditor })),
);

export function DcMarkdownEditor({
  value,
  onChange,
  resetKey,
}: {
  value: string;
  onChange: (markdown: string) => void;
  resetKey?: string;
}) {
  const useTextareaFallback =
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    (typeof navigator !== "undefined" && /happy-?dom|jsdom|bun/i.test(navigator.userAgent));
  if (useTextareaFallback) {
    return (
      <textarea
        key={resetKey}
        className="dc-editor-fallback"
        data-testid="dc-editor-fallback"
        aria-label="markdown editor"
        defaultValue={value}
        onInput={(event) => onChange(event.currentTarget.value)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  return (
    <Suspense fallback={<div className="dc-banner-muted">Loading editor…</div>}>
      <CrepeMarkdownEditor value={value} onChange={onChange} resetKey={resetKey} compact />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Budget: the run-level "$actual of $latestPredicted" progress bar.
// predicted comes from the LATEST plan/replan rollup, so the denominator can
// move when replans re-forecast — the fill width transitions instead of
// snapping (see .dc-budget-fill in dcCss).
// ---------------------------------------------------------------------------

export type BudgetBarModel = {
  hasPrediction: boolean;
  /** actual cost strictly above the latest prediction */
  over: boolean;
  /** clamped 0..1 fill fraction */
  fraction: number;
  /** clamped 0..100 fill width */
  percent: number;
  label: string;
  minutesLeft: number | null;
  minutesLabel: string | null;
};

export function budgetBarModel(budget: DcBudget | undefined): BudgetBarModel {
  const actualUsd = budget?.actual?.costUsd ?? 0;
  const predictedUsd = budget?.predicted?.costUsd ?? null;
  const hasPrediction = predictedUsd !== null && predictedUsd > 0;
  const over = hasPrediction && actualUsd > (predictedUsd as number);
  const fraction = hasPrediction ? Math.min(actualUsd / (predictedUsd as number), 1) : 0;
  const predictedMinutes = budget?.predicted?.minutes ?? null;
  const minutesLeft =
    predictedMinutes === null
      ? null
      : Math.max(0, Math.round(predictedMinutes - (budget?.actual?.minutes ?? 0)));
  const minutesLabel = minutesLeft === null || over ? null : `~${minutesLeft} min left`;
  const label = hasPrediction
    ? `${formatUsd(actualUsd)} of ~${formatUsd(predictedUsd as number)}`
    : `${formatUsd(actualUsd)} spent · no forecast yet`;
  return {
    hasPrediction,
    over,
    fraction,
    percent: Math.round(fraction * 1000) / 10,
    label,
    minutesLeft,
    minutesLabel,
  };
}

export function BudgetBar({ budget }: { budget: DcBudget | undefined }) {
  const model = budgetBarModel(budget);
  const actualUsd = budget?.actual?.costUsd ?? 0;
  if (!model.hasPrediction && actualUsd === 0) return null;
  return (
    <div
      className={"dc-budget" + (model.over ? " is-over" : "")}
      data-testid="dc-budget"
      title="Latest forecast from the plan/replan estimate rollup — the denominator moves when a replan re-forecasts"
    >
      <div className="dc-budget-track">
        <div className="dc-budget-fill" style={{ width: `${model.percent}%` }} />
      </div>
      <span className="dc-budget-label" data-testid="dc-budget-label">
        {model.label}
        {model.over ? " · over forecast" : model.minutesLabel ? ` · ${model.minutesLabel}` : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-node estimate chip: predicted vs actual (e.g. "~$1.20 → $0.95").
// ---------------------------------------------------------------------------

export type EstimateChipModel = { text: string; over: boolean };

export function estimateChipModel(
  node: Pick<DelegationNode, "estimate" | "actual">,
): EstimateChipModel | null {
  const predicted = node.estimate?.costUsd;
  const actual = node.actual?.costUsd;
  if (predicted === undefined && actual === undefined) return null;
  const over = predicted !== undefined && actual !== undefined && actual > predicted;
  const text =
    predicted !== undefined && actual !== undefined
      ? `~${formatUsd(predicted)} → ${formatUsd(actual)}`
      : predicted !== undefined
        ? `~${formatUsd(predicted)}`
        : formatUsd(actual as number);
  return { text, over };
}

export function EstimateChip({ node }: { node: Pick<DelegationNode, "estimate" | "actual" | "logicalId"> }) {
  const model = estimateChipModel(node);
  if (!model) return null;
  return (
    <span
      className={"dc-est" + (model.over ? " is-over" : "")}
      data-testid={`dc-est-${node.logicalId}`}
      title="predicted → actual cost"
    >
      {model.text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Human-request targeting. Rows folded from gateway records carry the physical
// node id when the reducer exposes it; fall back to the contract id scheme
// (dc:<logicalId>:...) so the UI still targets sensibly before that lands.
// ---------------------------------------------------------------------------

export function questionTarget(question: DcQuestion): { nodeId: string; iteration: number } {
  const row = question as unknown as Record<string, unknown>;
  const logicalId = asString(row.logicalId) || "root";
  const nodeId = asString(row.nodeId) || `dc:${logicalId}:question-${question.seq}`;
  const iteration = asNumber(row.iteration) ?? 0;
  return { nodeId, iteration };
}

export function goalApprovalTarget(graph: DelegationGraph): { nodeId: string; iteration: number } {
  const goal =
    Object.values(graph.nodes).find((node) => node.kind === "goal") ??
    (graph.rootId ? graph.nodes[graph.rootId] : undefined);
  const row = goal as unknown as Record<string, unknown> | undefined;
  const logicalId = goal?.logicalId ?? "root";
  const nodeId = asString(row?.approvalNodeId) || `dc:${logicalId}:approve`;
  const iteration = asNumber(row?.approvalIteration) ?? 0;
  return { nodeId, iteration };
}

/**
 * Whether the goal (refined-prompt) approval surface should render. True when
 * the goal approval is pending: the goal node folded to `awaiting-human`
 * (approval gates on `approve`/`approval-<n>` phases fold into node status),
 * OR the run sits in the goal phase with every question resolved and a dcGoal
 * row present (`refinedPrompt !== undefined`). A degraded agent can return
 * `refinedPrompt: ""` — the surface must STILL render (with a warning) so the
 * paused run always has something actionable on screen.
 */
export function goalApprovalPendingOf(graph: DelegationGraph): boolean {
  if (graph.pendingQuestions.some((question) => !question.resolved)) return false;
  const goal = Object.values(graph.nodes).find((node) => node.kind === "goal");
  if (goal?.status === "awaiting-human") return true;
  return graph.phase === "goal" && graph.refinedPrompt !== undefined;
}

/**
 * Question seqs whose HumanTask form is actually mounted, parsed from the
 * pending-approval physical node ids (`dc:<logicalId>:question-<seq>`).
 * Sorted ascending. Question ROWS prefetch ahead of the forms (haiku writes
 * form metadata early), so a row's existence does NOT mean it is answerable —
 * only a pending approval does.
 */
export function pendingQuestionSeqsOf(pendingApprovalIds: Iterable<string>): number[] {
  const seqs: number[] = [];
  for (const nodeId of pendingApprovalIds) {
    const match = /:question-(\d+)$/.exec(nodeId);
    if (match) seqs.push(Number(match[1]));
  }
  return seqs.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Phase indicator + preview-skip control.
// ---------------------------------------------------------------------------

export function PhaseStrip({ phase }: { phase: DcPhase }) {
  const activeIndex = DC_PHASES.indexOf(phase);
  return (
    <div className="dc-phases" data-testid="dc-phases">
      {DC_PHASES.map((entry, index) => (
        <span
          key={entry}
          className={
            "dc-phase" +
            (entry === phase ? " is-active" : "") +
            (index < activeIndex ? " is-done" : "")
          }
          data-testid={`dc-phase-${entry}`}
        >
          {entry}
        </span>
      ))}
    </div>
  );
}

export function SkipPreviewsButton({
  phase,
  actions,
}: {
  phase: DcPhase;
  actions: Pick<DcActions, "skipPreviews">;
}) {
  const [busy, setBusy] = useState(false);
  if (phase !== "preview") return null;
  return (
    <button
      type="button"
      className="button"
      data-testid="dc-skip-previews"
      disabled={busy}
      title="Previews are zero-backpressure calibration renders; skipping goes straight to gate planning"
      onClick={() => {
        setBusy(true);
        void actions.skipPreviews().finally(() => setBusy(false));
      }}
    >
      Skip previews
    </button>
  );
}

// ---------------------------------------------------------------------------
// Scores panel (per node + weighted run total when present).
// ---------------------------------------------------------------------------

function scoreValueText(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return "";
}

export function ScoresPanel({ scores }: { scores: Record<string, unknown> | undefined }) {
  if (!scores || Object.keys(scores).length === 0) return null;
  const entries = Object.entries(scores);
  const totalEntry = entries.find(([key]) => /total|weighted/i.test(key));
  const rest = entries.filter((entry) => entry !== totalEntry);
  return (
    <section className="card dc-scores" data-testid="dc-scores">
      <div className="card-head">
        <h3>Scores</h3>
        {totalEntry ? (
          <span className="badge info" data-testid="dc-score-total">
            {totalEntry[0]}: {scoreValueText(totalEntry[1]) || "—"}
          </span>
        ) : null}
      </div>
      <div className="dc-score-grid">
        {rest.map(([key, value]) => (
          <div className="dc-score-row" key={key} data-testid={`dc-score-${key}`}>
            <span className="dc-score-key">{key}</span>
            {isRecord(value) ? (
              <span className="dc-score-val">
                {Object.entries(value)
                  .map(([innerKey, innerValue]) => `${innerKey}: ${scoreValueText(innerValue) || "—"}`)
                  .join(" · ")}
              </span>
            ) : (
              <span className="dc-score-val">{scoreValueText(value) || "—"}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Delegation-chain specific CSS (layered on top of cw-theme tokens).
// Theme-aware via the cw-theme custom properties (light/dark handled there).
// ---------------------------------------------------------------------------

export const dcCss = [
  // layout
  ".dc-main { display:flex; flex:1 1 auto; min-height:0; }",
  ".dc-canvas { flex:1 1 auto; min-width:0; position:relative; background:var(--graph-bg); }",
  ".dc-rail { flex:0 0 440px; max-width:46vw; min-width:320px; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:14px; background:var(--surface); border-left:1px solid var(--border); }",
  "@media (max-width: 920px) { .dc-main { flex-direction:column; overflow:auto; } .dc-canvas { min-height:340px; flex:none; height:340px; } .dc-rail { flex:1 1 auto; max-width:none; border-left:0; border-top:1px solid var(--border); } }",
  // budget bar
  ".dc-budget { display:flex; align-items:center; gap:10px; min-width:230px; flex:0 1 360px; }",
  ".dc-budget-track { flex:1 1 60px; height:8px; border-radius:5px; background:var(--hover); border:1px solid var(--border); overflow:hidden; }",
  ".dc-budget-fill { height:100%; border-radius:5px; background:var(--brand); transition:width .6s ease, background-color .3s ease; }",
  ".dc-budget.is-over .dc-budget-fill { background:var(--bad); }",
  ".dc-budget.is-over .dc-budget-label { color:var(--bad); font-weight:650; }",
  ".dc-budget-label { white-space:nowrap; font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; }",
  // phase strip
  ".dc-phases { display:flex; align-items:center; gap:4px; padding:7px 18px; border-bottom:1px solid var(--border); overflow-x:auto; background:var(--surface); }",
  ".dc-phase { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); padding:3px 9px; border-radius:999px; border:1px solid transparent; white-space:nowrap; }",
  ".dc-phase.is-done { color:var(--ok); }",
  ".dc-phase.is-active { color:var(--brand); border-color:var(--brand); background:color-mix(in srgb, var(--brand) 10%, transparent); font-weight:700; }",
  // node cards
  ".dc-flownode { position:relative; }",
  ".dc-card { position:relative; width:240px; min-height:110px; border-radius:12px; border:1px solid var(--node-border); background:var(--node-bg); box-shadow:0 4px 14px var(--node-shadow); padding:10px 12px; display:flex; flex-direction:column; gap:6px; animation:dc-node-in .35s ease; cursor:pointer; }",
  "@keyframes dc-node-in { from { opacity:0; transform:translateY(6px) scale(.95); } to { opacity:1; transform:none; } }",
  ".dc-card.is-selected { border-color:var(--brand); box-shadow:0 0 0 2px color-mix(in srgb, var(--brand) 40%, transparent), 0 4px 14px var(--node-shadow); }",
  ".dc-card-poc, .dc-card-research { border-style:dotted; }",
  ".dc-card.is-invalidated { opacity:.45; border-style:dashed; }",
  ".dc-ghost { position:absolute; z-index:-1; inset:0; transform:translate(9px,9px); border-radius:12px; border:1px dashed var(--node-border); background:var(--graph-bg); opacity:.55; display:flex; align-items:flex-end; justify-content:flex-end; padding:4px 8px; font-size:10px; color:var(--text-faint); pointer-events:none; }",
  ".dc-kicker { display:flex; align-items:center; gap:6px; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--node-muted); }",
  ".dc-tier { font-weight:700; padding:1px 7px; border-radius:999px; border:1px solid var(--border-strong); color:var(--muted); }",
  ".dc-tier-fable { color:var(--brand); border-color:var(--brand); }",
  ".dc-tier-opus { color:#3b82f6; border-color:#3b82f6; }",
  ".dc-tier-sonnet { color:#14b8a6; border-color:#14b8a6; }",
  ".dc-tier-haiku { color:var(--text-faint); }",
  ".dc-kind { color:var(--node-muted); }",
  ".dc-version { font-weight:700; color:var(--brand); border:1px solid var(--brand); border-radius:5px; padding:0 5px; font-size:9.5px; }",
  ".dc-att { display:inline-flex; align-items:center; gap:3px; margin-left:auto; border:1px solid var(--warn); color:var(--warn); background:color-mix(in srgb, var(--warn) 12%, transparent); font-size:10px; font-weight:700; border-radius:999px; padding:1px 7px; cursor:pointer; animation:dc-pulse 1.6s ease-in-out infinite; }",
  "@keyframes dc-pulse { 0%,100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--warn) 45%, transparent); } 50% { box-shadow:0 0 0 6px transparent; } }",
  ".dc-title { font-size:12.5px; font-weight:650; color:var(--node-title); line-height:1.3; overflow-wrap:anywhere; }",
  ".dc-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }",
  ".dc-status { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:1px 7px; border-radius:5px; border:1px solid var(--border); color:var(--muted); }",
  ".dc-status-running, .dc-status-previewing, .dc-status-derisking { color:var(--brand); border-color:var(--brand); }",
  ".dc-status-ready { color:#14b8a6; border-color:#14b8a6; }",
  ".dc-status-awaiting-human { color:var(--warn); border-color:var(--warn); }",
  ".dc-status-done { color:var(--ok); border-color:var(--ok); }",
  ".dc-status-failed, .dc-status-invalidated { color:var(--bad); border-color:var(--bad); }",
  ".dc-est { font-size:10.5px; font-variant-numeric:tabular-nums; color:var(--muted); border:1px solid var(--border); border-radius:5px; padding:1px 6px; }",
  ".dc-est.is-over { color:var(--bad); border-color:var(--bad); font-weight:700; }",
  ".dc-gates { display:flex; gap:4px; flex-wrap:wrap; }",
  ".dc-gate { font-size:9.5px; font-weight:600; color:var(--node-muted); border:1px solid var(--border); border-radius:4px; padding:0 5px; }",
  ".dc-gate-approval { color:var(--warn); border-color:var(--warn); }",
  ".dc-gate-preview { color:var(--brand); border-color:var(--brand); }",
  // developer preview
  ".dc-devpreview-chip { font-size:9.5px; font-weight:700; color:var(--brand); border:1px solid var(--brand); border-radius:4px; padding:0 5px; }",
  ".dc-devpreview-chip.is-failed { color:var(--bad); border-color:var(--bad); background:color-mix(in srgb, var(--bad) 10%, transparent); }",
  ".dc-devpreview-frame { width:100%; min-height:260px; border:1px solid var(--border); border-radius:8px; background:#fff; }",
  ".dc-devpreview-link { display:inline-flex; align-items:center; gap:6px; font-weight:650; color:var(--brand); border:1px solid var(--brand); border-radius:8px; padding:8px 14px; text-decoration:none; }",
  ".dc-instructions { margin:0; padding:10px; border-radius:8px; background:var(--code-bg); color:var(--code-text); font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11.5px; white-space:pre-wrap; overflow-x:auto; }",
  // rail sections
  ".dc-section { display:flex; flex-direction:column; gap:8px; }",
  ".dc-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".dc-preview-banner { border:1px dashed var(--warn); color:var(--warn); background:color-mix(in srgb, var(--warn) 8%, transparent); padding:6px 10px; border-radius:8px; font-size:11px; font-weight:700; letter-spacing:.03em; }",
  ".dc-banner-bad { border:1px solid var(--bad); color:var(--bad); background:color-mix(in srgb, var(--bad) 8%, transparent); padding:6px 10px; border-radius:8px; font-size:11.5px; }",
  ".dc-banner-muted { border:1px solid var(--border); color:var(--muted); background:var(--hover-subtle); padding:6px 10px; border-radius:8px; font-size:11.5px; }",
  ".dc-versions { display:flex; gap:6px; flex-wrap:wrap; }",
  ".dc-version-item { font-size:11px; font-weight:600; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--muted); padding:3px 9px; cursor:pointer; }",
  ".dc-version-item.is-active { border-color:var(--brand); color:var(--brand); }",
  ".dc-version-item.is-invalidated { text-decoration:line-through; }",
  ".dc-attempt { border:1px solid var(--border); border-radius:8px; padding:8px 10px; display:flex; flex-direction:column; gap:4px; font-size:12px; }",
  ".dc-attempt-head { display:flex; align-items:center; gap:8px; }",
  ".dc-commit-chip { font-size:10px; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; border:1px solid var(--border); border-radius:5px; padding:1px 6px; background:var(--inline-code-bg); color:var(--muted); cursor:pointer; }",
  ".dc-commit-chip:hover { color:var(--text); border-color:var(--border-strong); }",
  ".dc-editor { display:flex; flex-direction:column; gap:8px; }",
  ".dc-editor-fallback { min-height:180px; width:100%; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); padding:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }",
  ".dc-refined .dc-editor-fallback { min-height:220px; }",
  ".dc-editor-actions { display:flex; gap:8px; align-items:center; }",
  ".dc-error-banner { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 14px; padding:8px 18px; border-bottom:1px solid color-mix(in srgb,var(--bad) 35%,var(--border)); background:color-mix(in srgb,var(--bad) 8%,var(--surface)); color:var(--bad); font-size:12px; }",
  ".dc-error-banner span { min-width:0; overflow-wrap:anywhere; }",
  // questions
  ".dc-question-reason { font-size:12px; color:var(--muted); border-left:2px solid var(--border); padding-left:10px; }",
  ".dc-option { display:flex; gap:8px; align-items:flex-start; padding:7px 9px; border:1px solid var(--border); border-radius:8px; cursor:pointer; }",
  ".dc-option.is-selected { border-color:var(--brand); background:color-mix(in srgb, var(--brand) 6%, transparent); }",
  ".dc-option input { margin-top:2px; }",
  ".dc-option-label { font-weight:600; font-size:12.5px; }",
  ".dc-option-desc { color:var(--muted); font-size:11.5px; }",
  ".dc-question-queue { display:flex; gap:6px; flex-wrap:wrap; }",
  ".dc-poll-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".dc-poll-q { font-size:12.5px; }",
  ".dc-poll-ratings { display:flex; gap:4px; }",
  ".dc-poll-rating { width:26px; height:26px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--muted); cursor:pointer; font-size:12px; }",
  ".dc-poll-rating.is-selected { border-color:var(--brand); color:var(--brand); font-weight:700; }",
  ".dc-refined { display:flex; flex-direction:column; gap:10px; }",
  // scores
  ".dc-score-grid { display:flex; flex-direction:column; gap:6px; }",
  ".dc-score-row { display:flex; gap:10px; justify-content:space-between; font-size:12px; }",
  ".dc-score-key { color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; }",
  ".dc-score-val { text-align:right; font-variant-numeric:tabular-nums; }",
  // markdown preview (minimal — the ddd MarkdownPreview markup)
  ".markdown-preview { font-size:12.5px; line-height:1.55; color:var(--text); display:flex; flex-direction:column; gap:8px; }",
  ".markdown-preview h1 { font-size:15px; } .markdown-preview h2 { font-size:13.5px; } .markdown-preview h3 { font-size:12.5px; }",
  ".markdown-preview pre.markdown-code { margin:0; padding:10px; border-radius:8px; background:var(--code-bg); color:var(--code-text); overflow-x:auto; font-size:11.5px; }",
  ".markdown-preview ul, .markdown-preview ol { margin:0; padding-left:18px; }",
  ".markdown-preview blockquote { margin:0; padding-left:10px; border-left:2px solid var(--border); color:var(--muted); }",
].join("\n");

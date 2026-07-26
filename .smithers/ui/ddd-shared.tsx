/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactNode } from "react";
import mermaid from "mermaid";
import { featuresData } from "./ddd-features.generated";
import { workflowSource, workflowSourcePath, workflowSources } from "./ddd-workflowSource.generated";
import type { DocsContentEntry } from "./ddd-docsContent.generated";

export type { DocsContentEntry };

export type TabKey = "features" | "specs" | "audit" | "live" | "tickets";

export type FeatureStatus = "fixed" | "partial" | "broken" | "missing-tests" | "missing";

export type FeatureTier = "feature" | "platform" | "reference";

export type FeatureLink = { label: string; href: string };
export type FeatureEndpoint = { method: string; path: string; doc?: string; note?: string };
export type FeatureCapability = { title: string; detail: string; status?: FeatureStatus; deckSlug?: string };

export type Feature = {
  id: string;
  title: string;
  summary: string;
  status: FeatureStatus;
  priority: string;
  owner: string;
  tier?: FeatureTier;
  group?: string;
  userValue?: string;
  image?: string;
  gif?: string;
  capabilities?: FeatureCapability[];
  endpoints?: FeatureEndpoint[];
  links?: FeatureLink[];
  tests?: string[];
  observability?: string[];
  debug?: string[];
  architecture?: string[];
  changes?: string[];
  evidence?: string[];
  diffHints?: string[];
  missing?: string[];
};

export type AuditRow = {
  generatedSiteBuilds?: boolean;
  featureIds?: string[];
  broken?: string[];
  partial?: string[];
  missingE2E?: string[];
  missingDocs?: string[];
  notes?: string[];
};

export type AuditFinding = { kind: "broken" | "partial" | "missingE2E" | "missingDocs"; featureId: string };

// Gateway rows are NOT exported from the gateway-react barrel — mirror them
// structurally and read defensively.
export type RunSummaryRow = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
};
export type EventFrame = { type?: string; event?: string; payload?: unknown; seq?: number; stateVersion?: number };
export type TicketRow = Record<string, unknown> & {
  path: string;
  kind?: string;
  content?: string;
  status?: string | null;
  priority?: string | null;
  severity?: string | null;
  updatedAtMs?: number;
};

export const features = featuresData as unknown as Feature[];

export const statusLabels: Record<FeatureStatus, string> = {
  fixed: "Fixed",
  partial: "Partial",
  broken: "Broken",
  "missing-tests": "Missing e2e",
  missing: "Missing",
};

export const findingLabels: Record<AuditFinding["kind"], string> = {
  broken: "Broken",
  partial: "Partial",
  missingE2E: "Missing e2e",
  missingDocs: "Missing docs",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function strings(value: unknown): string[] {
  return asArray(value).map(asString).filter(Boolean);
}
export function rowOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.row)) return value.row;
  if (isRecord(value.data) && isRecord(value.data.row)) return value.data.row;
  if (isRecord(value.data)) return value.data;
  return value;
}

export function paramFromUrl(name: string): string | undefined {
  const search =
    typeof window !== "undefined" && window.location
      ? window.location.search
      : typeof location !== "undefined"
        ? location.search
        : "";
  if (!search) return undefined;
  return new URLSearchParams(search).get(name) ?? undefined;
}
export function runIdFromUrl(): string | undefined {
  return paramFromUrl("runId");
}
/**
 * v1 ships no asset server: when the page has no `?assetBaseUrl` param this is
 * undefined, Crepe image upload is disabled, and the header Assets link hides.
 */
export function assetBaseFromUrl(): string | undefined {
  const base = paramFromUrl("assetBaseUrl");
  return base ? base.replace(/\/+$/, "") : undefined;
}

export function normalizeStatus(status: string | undefined): string {
  return asString(status).trim().toLowerCase().replaceAll("_", "-");
}

export function formatStatus(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (!normalized) return "";
  const labels: Record<string, string> = {
    ok: "Complete",
    success: "Complete",
    fixed: "Fixed",
    ready: "Ready",
    done: "Done",
    finished: "Finished",
    running: "Running",
    pending: "Pending",
    queued: "Queued",
    waiting: "Waiting",
    "waiting-approval": "Waiting for approval",
    "waiting-event": "Waiting for event",
    "waiting-timer": "Waiting on timer",
    partial: "Partial",
    "missing-tests": "Missing e2e",
    missing: "Missing",
    broken: "Broken",
    blocked: "Blocked",
    failed: "Failed",
    error: "Error",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    skipped: "Skipped",
    todo: "Todo",
    open: "Open",
    closed: "Closed",
  };
  return (
    labels[normalized] ??
    normalized
      .split("-")
      .map((part) => (part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
      .join(" ")
  );
}

export function statusClass(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (["fixed", "ready", "done", "finished", "success", "ok", "complete", "completed", "closed"].includes(normalized))
    return "ok";
  if (["broken", "blocked", "failed", "failure", "error"].includes(normalized)) return "bad";
  if (
    [
      "partial",
      "missing-tests",
      "missing",
      "running",
      "pending",
      "queued",
      "waiting",
      "cancelled",
      "canceled",
      "todo",
      "open",
    ].includes(normalized) ||
    normalized.startsWith("waiting-")
  )
    return "warn";
  return "muted";
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(Math.trunc(value));
  }
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  const label = Math.abs(count) === 1 ? singular : plural;
  return `${formatNumber(count)} ${label}`;
}

export const featureTierLabels: Record<FeatureTier, string> = {
  feature: "Feature",
  platform: "Platform",
  reference: "Reference",
};

export function formatFeatureTier(tier: string | undefined): string {
  const normalized = normalizeStatus(tier);
  return featureTierLabels[normalized as FeatureTier] ?? formatStatus(normalized);
}

export const ticketKindLabels: Record<string, string> = {
  ticket: "Ticket",
  issue: "Issue",
  fix: "Fix",
  e2e: "E2E",
  review: "Review",
  feature: "Feature",
  docs: "Docs",
};

export function formatTicketKind(kind: string | undefined): string {
  const normalized = normalizeStatus(kind);
  if (!normalized) return "Ticket";
  return ticketKindLabels[normalized] ?? formatStatus(normalized);
}

const ticketSeverityLabels: Record<string, string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
};

const ticketSeverityRanks: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

const ticketPriorityRanks: Record<string, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
};

export function normalizePriority(priority: unknown): string {
  const normalized = normalizeStatus(asString(priority));
  if (/^p\d+$/.test(normalized)) return normalized;
  if (/^\d+$/.test(normalized)) return `p${normalized}`;
  return normalized;
}

export function formatPriority(priority: unknown): string {
  const normalized = normalizePriority(priority);
  return /^p\d+$/.test(normalized) ? normalized.toUpperCase() : formatStatus(normalized);
}

export function priorityRank(priority: unknown): number {
  const normalized = normalizePriority(priority);
  return ticketPriorityRanks[normalized] ?? 99;
}

export function normalizeSeverity(severity: unknown): string {
  const normalized = normalizeStatus(asString(severity));
  if (["critical", "blocker", "p0"].includes(normalized)) return "critical";
  if (["major", "high", "p1"].includes(normalized)) return "major";
  if (["minor", "low", "info", "p2"].includes(normalized)) return "minor";
  return normalized;
}

export function formatSeverity(severity: unknown): string {
  const normalized = normalizeSeverity(severity);
  return ticketSeverityLabels[normalized] ?? formatStatus(normalized);
}

export function severityRank(severity: unknown): number {
  const normalized = normalizeSeverity(severity);
  return ticketSeverityRanks[normalized] ?? 99;
}

export function severityClass(severity: unknown): string {
  const rank = severityRank(severity);
  if (rank === 0) return "bad";
  if (rank === 1) return "warn";
  return "muted";
}

export function ticketRiskClass(priority: unknown, severity: unknown): "bad" | "warn" | "muted" {
  if (severityRank(severity) === 0 || priorityRank(priority) === 0) return "bad";
  if (severityRank(severity) === 1 || priorityRank(priority) === 1) return "warn";
  return "muted";
}

export function isTerminalRunStatus(status: string | undefined): boolean {
  const normalized = normalizeStatus(status);
  return [
    "done",
    "finished",
    "success",
    "ok",
    "complete",
    "completed",
    "failed",
    "failure",
    "error",
    "cancelled",
    "canceled",
    "skipped",
  ].includes(normalized);
}

export function isFailedTerminalRunStatus(status: string | undefined): boolean {
  const normalized = normalizeStatus(status);
  return ["failed", "failure", "error", "cancelled", "canceled"].includes(normalized);
}

export function fmtTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Compact a long runId to `head...tail` for chips; short ids pass through. */
export function shortRunId(runId: string): string {
  return runId.length <= 24 ? runId : `${runId.slice(0, 12)}...${runId.slice(-8)}`;
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return asString(error);
}

export function ErrorBanner({ title, errors }: { title: string; errors: unknown[] }) {
  const messages = [
    ...new Set(
      errors
        .map(errorMessage)
        .map((message) => message.trim())
        .filter(Boolean),
    ),
  ];
  if (messages.length === 0) return null;
  return (
    <section className="error-banner" role="alert" data-testid="ddd-error-banner">
      <strong>{title}</strong>
      {messages.map((message, index) => (
        <p key={`${title}:${index}`}>{message}</p>
      ))}
    </section>
  );
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const activeDialogStack: HTMLElement[] = [];

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    return element.tabIndex >= 0;
  });
}

function removeDialogFromStack(container: HTMLElement) {
  const index = activeDialogStack.lastIndexOf(container);
  if (index >= 0) activeDialogStack.splice(index, 1);
}

/**
 * Trap focus inside the top-most dialog, close on Escape, and restore the
 * element that opened it. Multiple DDD overlays can coexist, so only the last
 * mounted dialog responds to keyboard events.
 */
export function useDialogFocusTrap({
  active = true,
  containerRef,
  initialFocusRef,
  onClose,
}: {
  active?: boolean;
  containerRef: { current: HTMLElement | null };
  initialFocusRef?: { current: HTMLElement | null };
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const container = containerRef.current;
    if (!container) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeDialogStack.push(container);

    const isTopDialog = () => activeDialogStack.at(-1) === container;
    const focusInitial = () => {
      const target = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
      target.focus();
    };

    window.requestAnimationFrame(focusInitial);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      } else if (!container.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopDialog()) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && container.contains(target)) return;
      focusInitial();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      removeDialogFromStack(container);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, containerRef, initialFocusRef]);
}

export function normalizeMarkdownForDirty(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

export type DraftChangedFile = { path: string; beforeMarkdown: string; afterMarkdown: string };

export type DraftReconciliationResult = {
  nextDrafts: Record<string, string>;
  appliedPaths: string[];
  clearedPaths: string[];
  retainedPaths: string[];
  updatedPaths: string[];
};

export type DraftRunNotice = {
  runId: string;
  state: "applied" | "retained" | "not-applied" | "failed";
  clearedPaths: string[];
  retainedPaths: string[];
  updatedPaths: string[];
  summary: string;
};

export function normalizeSpecDocPath(path: unknown): string {
  return asString(path)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/*/, "")
    .replace(/^smithers\/spec\/content\//, ".smithers/spec/content/")
    .replace(/^\.smithers\/spec\/content\//, "")
    .replace(/^spec\/content\//, "");
}

export function changedFilesFromMetaTicket(metaTicket: unknown): DraftChangedFile[] {
  const row = rowOf(metaTicket);
  return asArray(row?.changedFiles ?? row?.changed_files)
    .filter(isRecord)
    .map((file) => ({
      path: normalizeSpecDocPath(file.path),
      beforeMarkdown: asString(file.beforeMarkdown ?? file.before_markdown),
      afterMarkdown: asString(file.afterMarkdown ?? file.after_markdown),
    }))
    .filter((file) => file.path.length > 0);
}

export function updatedDocPathsFromSpec(spec: unknown): string[] {
  const row = rowOf(spec);
  return strings(row?.updatedFiles ?? row?.updated_files)
    .map(normalizeSpecDocPath)
    .filter((path) => path.length > 0);
}

export function reconcileDraftsAfterRun(
  drafts: Record<string, string>,
  changedFiles: ReadonlyArray<DraftChangedFile>,
  updatedFiles: ReadonlyArray<string>,
): DraftReconciliationResult {
  const updated = new Set(updatedFiles.map(normalizeSpecDocPath).filter(Boolean));
  const nextDrafts = { ...drafts };
  const appliedPaths: string[] = [];
  const clearedPaths: string[] = [];
  const retainedPaths: string[] = [];

  for (const file of changedFiles) {
    const path = normalizeSpecDocPath(file.path);
    if (!path) continue;
    if (updated.has(path)) appliedPaths.push(path);
    const currentDraft = drafts[path];
    if (currentDraft === undefined) continue;
    if (
      updated.has(path) &&
      normalizeMarkdownForDirty(currentDraft) === normalizeMarkdownForDirty(file.afterMarkdown)
    ) {
      delete nextDrafts[path];
      clearedPaths.push(path);
    } else {
      retainedPaths.push(path);
    }
  }

  return {
    nextDrafts,
    appliedPaths: [...new Set(appliedPaths)],
    clearedPaths: [...new Set(clearedPaths)],
    retainedPaths: [...new Set(retainedPaths)],
    updatedPaths: [...updated],
  };
}

const SPEC_DRAFTS_STORAGE_KEY = "smithers.ddd.specDrafts.v1";

function localStorageSafe(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    const probe = "__smithers_ddd_draft_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function loadSpecDrafts(docs: ReadonlyArray<DocsContentEntry>): Record<string, string> {
  const storage = localStorageSafe();
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(SPEC_DRAFTS_STORAGE_KEY) ?? "{}");
    const rawDrafts = isRecord(parsed) && isRecord(parsed.drafts) ? parsed.drafts : isRecord(parsed) ? parsed : {};
    const docsByPath = new Map(docs.map((doc) => [doc.path, doc]));
    const drafts: Record<string, string> = {};
    for (const [path, value] of Object.entries(rawDrafts)) {
      const doc = docsByPath.get(path);
      if (!doc || doc.level !== "product" || typeof value !== "string") continue;
      if (normalizeMarkdownForDirty(value) === normalizeMarkdownForDirty(doc.content)) continue;
      drafts[path] = value;
    }
    return drafts;
  } catch {
    return {};
  }
}

export function saveSpecDrafts(drafts: Record<string, string>) {
  const storage = localStorageSafe();
  if (!storage) return;
  try {
    if (Object.keys(drafts).length === 0) {
      storage.removeItem(SPEC_DRAFTS_STORAGE_KEY);
      return;
    }
    storage.setItem(SPEC_DRAFTS_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), drafts }));
  } catch {
    // Draft persistence is best-effort; the in-memory editor remains usable.
  }
}

export function makeAssetUrl(assetBase: string | undefined) {
  return (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    if (/^https?:\/\//.test(path)) return path;
    if (assetBase && (path.startsWith("/evidence/") || path.startsWith("/deck-assets/"))) return `${assetBase}${path}`;
    return path;
  };
}

export async function uploadAsset(assetBase: string, file: File): Promise<string> {
  const response = await fetch(`${assetBase}/upload`, {
    method: "POST",
    headers: { "x-filename": file.name },
    body: file,
  });
  if (!response.ok) throw new Error(`asset upload failed: ${response.status}`);
  const json = (await response.json()) as { url?: string };
  if (!json.url) throw new Error("asset upload returned no url");
  return json.url;
}

function frameEnvelope(frame: EventFrame): { event: string; payload: Record<string, unknown> } | null {
  const outerPayload = isRecord(frame.payload) ? frame.payload : {};
  const wrappedEvent = typeof outerPayload.event === "string" ? outerPayload.event : asString(outerPayload.type);
  if (wrappedEvent) {
    return {
      event: wrappedEvent,
      payload: isRecord(outerPayload.payload) ? outerPayload.payload : outerPayload,
    };
  }
  const event = typeof frame.event === "string" ? frame.event : asString(frame.type);
  if (!event) return null;
  return { event, payload: outerPayload };
}

function finiteSeq(value: unknown): number {
  const seq = Number(value ?? 0);
  return Number.isFinite(seq) ? seq : 0;
}

/**
 * Run-event frames are double-wrapped: the real domain event + data live at
 * `frame.payload.event` / `frame.payload.payload`. The gateway's mapEvent remaps
 * engine events to a PUBLIC dotted vocabulary before streaming — e.g. NodeOutput
 * → `task.output` (text under `payload.output`), AgentTraceEvent → `agent.trace`
 * (text under `payload.trace.payload.text`), node.started/finished/failed,
 * run.completed/failed/cancelled, approval.*. Match those, not the engine names.
 */
export function chatLineFromFrame(frame: EventFrame): { who: string; text: string } | null {
  const env = frameEnvelope(frame);
  if (!env) return null;
  const { event, payload } = env;
  if (event === "task.output") {
    const text = asString(payload.output);
    if (text.trim()) return { who: asString(payload.nodeId) || "node", text };
  }
  if (event === "agent.trace" || event === "AgentTraceEvent") {
    const trace = isRecord(payload.trace) ? payload.trace : undefined;
    const tracePayload = trace && isRecord(trace.payload) ? trace.payload : undefined;
    const text = tracePayload ? asString(tracePayload.text) : "";
    if (text.trim()) return { who: asString(payload.nodeId) || "agent", text };
  }
  if (event === "AgentEvent" || event === "agent.event") {
    const agentEvent = isRecord(payload.event) ? payload.event : undefined;
    const text = agentEvent ? asString(agentEvent.message) : "";
    if (text.trim()) return { who: asString(payload.nodeId) || asString(payload.engine) || "agent", text };
  }
  if (event === "NodeOutput" || event === "TaskOutput") {
    const text = asString(payload.output ?? payload.text);
    if (text.trim()) return { who: asString(payload.nodeId) || "node", text };
  }
  return null;
}

/**
 * A single rendered conversation line. `kind` distinguishes a real chat message
 * (assistant/user/system/tool transcript turn or streaming assistant text) from
 * raw node `output` text and tool-activity lines.
 */
export type ChatLine = { who: string; role?: string; text: string; kind: "message" | "tool" | "output" };

// agent.event `event.type` values that carry conversational assistant text.
const TEXT_EVENT_TYPES = new Set(["text", "message", "assistant_message", "output_text", "reasoning"]);

/**
 * Flatten one transcript-message `content` (a string OR an array of blocks like
 * `{type:"text",text}` / tool_use / tool_result / reasoning) into display text:
 * concatenate text/reasoning blocks, summarize tool-use blocks, drop tool results.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const parts: string[] = [];
  for (const block of asArray(content)) {
    if (!isRecord(block)) {
      const raw = asString(block);
      if (raw.trim()) parts.push(raw);
      continue;
    }
    const type = asString(block.type);
    if (type === "text" || type === "output_text" || type === "reasoning" || type === "thinking") {
      const text = asString(block.text) || asString(block.thinking);
      if (text.trim()) parts.push(text);
    } else if (type === "tool_use" || type === "tool-use" || type === "tool_call") {
      parts.push(`↗ ${asString(block.name) || "tool"}`);
    } else if (type === "tool_result" || type === "tool-result") {
      // Tool results are noisy/long; the Live log already surfaces tool activity.
    } else {
      const text = asString(block.text);
      if (text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Conversational view of a frame: ZERO-OR-MORE chat lines. Unlike
 * {@link chatLineFromFrame} (one raw line, used by the live feed), this expands
 * an `agent.session` transcript into one line per message and ignores tool/command
 * activity so the chat panel reads like the agent's actual conversation.
 */
export function chatLinesFromFrame(frame: EventFrame): ChatLine[] {
  const env = frameEnvelope(frame);
  if (!env) return [];
  const { event, payload } = env;
  const lines: ChatLine[] = [];

  if (event === "agent.session" || event === "AgentSessionEvent") {
    for (const message of asArray(payload.transcript)) {
      if (!isRecord(message)) continue;
      const role = asString(message.role);
      const text = contentToText(message.content);
      if (!text) continue;
      lines.push({ who: role || "agent", role: role || undefined, text, kind: "message" });
    }
    return lines;
  }

  if (event === "agent.event" || event === "AgentEvent") {
    const agentEvent = isRecord(payload.event) ? payload.event : undefined;
    if (!agentEvent) return lines;
    const type = asString(agentEvent.type);
    const who = asString(payload.engine) || asString(agentEvent.engine) || asString(payload.nodeId) || "agent";
    const action = isRecord(agentEvent.action) ? agentEvent.action : undefined;
    const kind = action ? asString(action.kind) : "";
    const detailType =
      action && isRecord(action.detail) ? asString((action.detail as Record<string, unknown>).type) : "";
    const title = action ? asString(action.title) : "";
    const entryType = asString(agentEvent.entryType);

    // CLI agents (codex/claude-code) wrap everything in an `action` envelope where
    // the conversational text lives in `.message`, the real category in
    // `action.kind` / `entryType` / `action.detail.type`. The assistant's words
    // arrive as an `agent_message` (entryType "message"); command/tool/turn/warning
    // activity stays in the Live log so the chat reads like a real conversation.
    if (type === "action") {
      const message = asString(agentEvent.message);
      const isAssistantMessage = detailType === "agent_message" || title === "assistant" || entryType === "message";
      if (isAssistantMessage && message.trim()) {
        lines.push({ who, role: "assistant", text: message, kind: "message" });
      } else if (kind === "reasoning" && message.trim()) {
        lines.push({ who, role: "reasoning", text: message, kind: "message" });
      }
      return lines;
    }

    // A CLI turn's final answer ({ type: "completed", answer }). De-dup in
    // buildChatLines drops it when an identical agent_message already rendered.
    if (type === "completed") {
      const answer = asString(agentEvent.answer) || asString(agentEvent.message);
      if (answer.trim()) lines.push({ who, role: "assistant", text: answer, kind: "message" });
      return lines;
    }

    // Other engines: discrete conversational text/reasoning events.
    const text = asString(agentEvent.text) || asString(agentEvent.message) || asString(agentEvent.delta);
    if ((TEXT_EVENT_TYPES.has(type) || (!type && text.trim())) && text.trim()) {
      lines.push({ who, role: type === "reasoning" ? "reasoning" : "assistant", text, kind: "message" });
    }
    return lines;
  }

  if (event === "task.output" || event === "NodeOutput" || event === "TaskOutput") {
    const text = asString(payload.output ?? payload.text);
    if (text.trim()) lines.push({ who: asString(payload.nodeId) || "node", text, kind: "output" });
    return lines;
  }

  if (event === "agent.trace" || event === "AgentTraceEvent") {
    const trace = isRecord(payload.trace) ? payload.trace : undefined;
    const tracePayload = trace && isRecord(trace.payload) ? trace.payload : undefined;
    const text = tracePayload ? asString(tracePayload.text) : "";
    if (text.trim()) lines.push({ who: asString(payload.nodeId) || "agent", role: "assistant", text, kind: "message" });
    return lines;
  }

  return lines;
}

function normalizeChatText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function sourceKeyFromPayload(payload: Record<string, unknown>, fallback: string): string {
  const sessionRecord = isRecord(payload.session) ? payload.session : {};
  const node = asString(payload.nodeId ?? payload.node_id ?? payload.node ?? payload.taskId ?? payload.task_id);
  const session = asString(payload.sessionId ?? payload.session_id ?? sessionRecord.id ?? payload.id);
  const engine = asString(payload.engine);
  return [node, session, engine].filter(Boolean).join(":") || fallback;
}

function chatSourceKey(frame: EventFrame, fallbackPrefix: string): string {
  const env = frameEnvelope(frame);
  if (!env) return `${fallbackPrefix}:unknown`;
  return `${fallbackPrefix}:${sourceKeyFromPayload(env.payload, "global")}`;
}

/**
 * Build a clean, de-duplicated conversation for the Chat logs panel.
 *
 * `agent.session` events fire repeatedly, each carrying that node/session's
 * cumulative transcript. Real DDD runs have separate cumulative sessions for
 * audit, spec-update, triage, work, and review, so de-dupe per node/session
 * instead of picking one global best transcript.
 */
export function buildChatLines(frames: EventFrame[]): ChatLine[] {
  const sessionEventOf = (frame: EventFrame): string => {
    return frameEnvelope(frame)?.event ?? "";
  };
  const isSession = (frame: EventFrame): boolean => {
    const event = sessionEventOf(frame);
    return event === "agent.session" || event === "AgentSessionEvent";
  };

  const sessions = new Map<string, { firstSeq: number; seq: number; lines: ChatLine[] }>();
  for (const frame of frames) {
    if (!isSession(frame)) continue;
    const candidate = chatLinesFromFrame(frame);
    const seq = finiteSeq(frame.seq);
    const key = chatSourceKey(frame, "session");
    const best = sessions.get(key);
    if (!best || candidate.length > best.lines.length || (candidate.length === best.lines.length && seq > best.seq)) {
      sessions.set(key, { firstSeq: best ? Math.min(best.firstSeq, seq) : seq, seq, lines: candidate });
    } else if (seq < best.firstSeq) {
      sessions.set(key, { ...best, firstSeq: seq });
    }
  }

  const result: ChatLine[] = [];
  const seenBySource = new Map<string, Set<string>>();
  const sessionBlobBySource = new Map<string, string>();
  const allSessionBlobs: string[] = [];
  for (const [source, session] of [...sessions.entries()].sort((left, right) => left[1].firstSeq - right[1].firstSeq)) {
    const seen = seenBySource.get(source) ?? new Set<string>();
    seenBySource.set(source, seen);
    const sessionParts: string[] = [];
    for (const line of session.lines) {
      const key = normalizeChatText(line.text);
      if (!key || seen.has(key)) continue;
      result.push(line);
      seen.add(key);
      sessionParts.push(key);
    }
    const blob = sessionParts.join("\n");
    sessionBlobBySource.set(source, blob);
    if (blob) allSessionBlobs.push(blob);
  }
  for (const frame of frames) {
    if (isSession(frame)) continue;
    const source = chatSourceKey(frame, "session");
    const seen = seenBySource.get(source) ?? new Set<string>();
    seenBySource.set(source, seen);
    const sourceBlob = sessionBlobBySource.get(source) ?? "";
    for (const line of chatLinesFromFrame(frame)) {
      const key = normalizeChatText(line.text);
      if (!key || seen.has(key)) continue;
      if (sourceBlob && sourceBlob.includes(key)) continue; // streaming fragment already in this transcript
      if (!sourceBlob && allSessionBlobs.some((blob) => blob.includes(key))) continue;
      seen.add(key);
      result.push(line);
    }
  }
  return result;
}

function formatDuration(ms: unknown): string {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder ? `${minutes} min ${remainder} s` : `${minutes} min`;
}

function shortText(value: string, limit = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function parseStructuredText(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function summarizeStructured(value: unknown): string {
  if (Array.isArray(value)) return formatCount(value.length, "item");
  if (!isRecord(value)) return shortText(asString(value));

  const row = isRecord(value.row) ? value.row : value;
  const parts: string[] = [];
  const status = asString(row.status);
  const summary = asString(row.summary) || asString(row.message) || asString(row.title);
  if (status) parts.push(formatStatus(status));
  if (summary && summary !== status) parts.push(shortText(summary, 140));

  const countFields: Array<[string, string, string]> = [
    ["selected", "slot", "slots"],
    ["tickets", "ticket", "tickets"],
    ["ticketPaths", "ticket", "tickets"],
    ["featuresUpdated", "feature", "features"],
    ["findings", "finding", "findings"],
    ["confirmed", "confirmed", "confirmed"],
    ["rejected", "rejected", "rejected"],
    ["changedFiles", "file", "files"],
    ["files", "file", "files"],
  ];
  for (const [key, singular, plural] of countFields) {
    const count = asArray(row[key]).length;
    if (count > 0) parts.push(formatCount(count, singular, plural));
  }

  if (typeof row.buildPassed === "boolean") parts.push(row.buildPassed ? "build passed" : "build failed");
  if (typeof row.docsBuildPassed === "boolean")
    parts.push(row.docsBuildPassed ? "docs build passed" : "docs build failed");
  const duration = formatDuration(row.durationMs ?? row.elapsedMs ?? row.elapsed_ms);
  if (duration) parts.push(duration);

  if (parts.length > 0) return parts.join(" · ");
  return formatCount(Object.keys(row).length, "field");
}

function summarizeEventValue(value: unknown): string {
  if (typeof value === "string") {
    const structured = parseStructuredText(value);
    return structured === null ? shortText(value) : summarizeStructured(structured);
  }
  if (isRecord(value) || Array.isArray(value)) return summarizeStructured(value);
  return shortText(asString(value));
}

/**
 * Generic one-line view of any run event for the live log (the `smithers up
 * --interactive` style feed). Renders every public event, not just agent text.
 */
/** Event tone for the live feed: failures read red, waits/retries amber. */
function logToneFor(event: string, status: string): "ok" | "warn" | "bad" | "" {
  const verb = event.split(".").at(-1) ?? "";
  if (/fail|error|reject|crash|abort/i.test(verb)) return "bad";
  const statusTone = status ? statusClass(status) : "";
  if (statusTone === "bad") return "bad";
  if (/retry|retrying|timeout|stall|degrad/i.test(verb)) return "warn";
  if (/complete|finish|success|done|resolved/i.test(verb) || statusTone === "ok") return "ok";
  if (statusTone === "warn") return "warn";
  return "";
}

export function logLineFromFrame(
  frame: EventFrame,
): { seq: number; event: string; node: string; detail: string; tone: "ok" | "warn" | "bad" | "" } | null {
  const env = frameEnvelope(frame);
  if (!env) return null;
  const { event, payload } = env;
  if (!event || event === "run.heartbeat" || event === "task.heartbeat") return null;
  const node = asString(payload.nodeId ?? payload.node ?? payload.id);
  const trace = isRecord(payload.trace) ? payload.trace : undefined;
  const tracePayload = trace && isRecord(trace.payload) ? trace.payload : undefined;
  const agentEvent = isRecord(payload.event) ? payload.event : undefined;
  let detail = "";

  if (event === "task.output" || event === "NodeOutput" || event === "TaskOutput") {
    detail = summarizeEventValue(payload.output ?? payload.text);
  } else if (event === "agent.session" || event === "AgentSessionEvent") {
    detail = formatCount(asArray(payload.transcript).length, "message");
  } else if (event === "agent.event" || event === "AgentEvent") {
    const type = agentEvent ? asString(agentEvent.type) : "";
    const action = agentEvent && isRecord(agentEvent.action) ? agentEvent.action : undefined;
    const actionKind = action ? asString(action.kind) || asString(action.title) : "";
    if (type === "completed")
      detail = `Completed${asString(agentEvent?.answer) ? `: ${shortText(asString(agentEvent?.answer), 160)}` : ""}`;
    else if (type === "action")
      detail = [formatStatus(actionKind) || "Action", shortText(asString(agentEvent?.message), 160)]
        .filter(Boolean)
        .join(": ");
    else
      detail = [
        formatStatus(type),
        shortText(asString(agentEvent?.message ?? agentEvent?.text ?? agentEvent?.delta), 160),
      ]
        .filter(Boolean)
        .join(": ");
  } else if (event === "agent.trace" || event === "AgentTraceEvent") {
    detail = shortText(tracePayload ? asString(tracePayload.text) : "");
  } else if (event.startsWith("node.")) {
    const verb = event.split(".").at(-1) ?? "event";
    const duration = formatDuration(payload.durationMs ?? payload.elapsedMs ?? payload.elapsed_ms);
    detail = [
      formatStatus(verb),
      formatStatus(asString(payload.status)),
      duration,
      shortText(asString(payload.message), 120),
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (event.startsWith("run.")) {
    const verb = event.split(".").at(-1) ?? "event";
    const duration = formatDuration(payload.durationMs ?? payload.elapsedMs ?? payload.elapsed_ms);
    detail = [
      formatStatus(asString(payload.status)) || formatStatus(verb),
      duration,
      shortText(asString(payload.message), 120),
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (payload.output !== undefined || payload.text !== undefined) {
    detail = summarizeEventValue(payload.output ?? payload.text);
  } else {
    detail =
      [formatStatus(asString(payload.status)), shortText(asString(payload.message), 180)].filter(Boolean).join(" · ") ||
      summarizeStructured(payload);
  }

  const tone = logToneFor(event, asString(payload.status));
  return { seq: finiteSeq(frame.seq), event, node, detail: shortText(detail, 260), tone };
}

export function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="list-block">
      <strong>{title}</strong>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}:${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** Resolve `..`/`.`/empty segments in a `/`-joined path. */
function normalizeSegments(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export type DocLinkTarget =
  | { kind: "external"; href: string }
  | { kind: "doc"; path: string; anchor: string }
  | { kind: "anchor"; anchor: string };

/**
 * Resolve a markdown link `href` written inside the doc at `fromPath` to a real
 * target. Doc paths are content-root-relative (e.g. `overview.md`,
 * `features/<id>.md`); internal `.md` links are written either relative to the
 * doc's own directory (`../features/x.md`) or relative to the content root
 * (`features/x.md`) — we try both and keep the one that exists. Returns an
 * `external` URL, a resolved `doc` (+ optional `#anchor`), a same-page `anchor`,
 * or `null` when nothing matches (dead link).
 */
export function resolveDocLink(
  fromPath: string,
  href: string,
  hasPath: (path: string) => boolean,
): DocLinkTarget | null {
  const trimmed = (href ?? "").trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("mailto:")) {
    return { kind: "external", href: trimmed };
  }
  const hashIdx = trimmed.indexOf("#");
  const rawPath = (hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed).trim();
  const anchor = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : "";
  if (!rawPath) return anchor ? { kind: "anchor", anchor } : null;

  const baseDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const candidates = [
    normalizeSegments([...(baseDir ? baseDir.split("/") : []), ...rawPath.split("/")]),
    normalizeSegments(rawPath.split("/")),
  ];
  for (const candidate of candidates) {
    if (candidate && hasPath(candidate)) return { kind: "doc", path: candidate, anchor };
  }
  return null;
}

export function MarkdownEditor({
  docPath,
  initialValue,
  resetKey = 0,
  assetBase,
  onChange,
  onLinkClick,
}: {
  docPath: string;
  initialValue: string;
  resetKey?: number;
  /** Undefined when the page has no ?assetBaseUrl — image upload is disabled. */
  assetBase: string | undefined;
  onChange: (markdown: string) => void;
  /** Called for relative (in-spec) link clicks; external + same-page anchors are handled here. */
  onLinkClick?: (href: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [fallbackValue, setFallbackValue] = useState(initialValue);
  const fallbackValueRef = useRef(initialValue);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const useTextareaFallback =
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !document?.createElement ||
    (typeof navigator !== "undefined" && /happy-?dom|jsdom|\bBun\//i.test(navigator.userAgent));

  useEffect(() => {
    fallbackValueRef.current = initialValue;
    setFallbackValue(initialValue);
  }, [docPath, initialValue, resetKey, retryKey]);

  const onFallbackInput = (value: string) => {
    if (value === fallbackValueRef.current) return;
    fallbackValueRef.current = value;
    setFallbackValue(value);
    onChangeRef.current(value);
  };

  useEffect(() => {
    if (useTextareaFallback) return;
    const host = hostRef.current;
    if (!host) return;
    const base = assetBase;
    let cancelled = false;
    let crepe: { destroy: () => unknown } | null = null;
    let userEdited = false;
    setLoadState("loading");
    setLoadError("");
    host.innerHTML = "";
    const markUserEdited = () => {
      userEdited = true;
    };
    const fail = (error: unknown) => {
      if (cancelled) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoadState("failed");
      try {
        void crepe?.destroy();
      } catch {
        // Fallback textarea remains editable even if cleanup itself fails.
      }
    };

    void import("@milkdown/crepe")
      .then(({ Crepe }) => {
        if (cancelled) return;
        const editor = new Crepe({
          root: host,
          defaultValue: initialValue,
          // No asset server in v1: only wire Crepe's image upload when the page was
          // opened with ?assetBaseUrl.
          featureConfigs: base
            ? {
                [Crepe.Feature.ImageBlock]: {
                  onUpload: (file) => uploadAsset(base, file),
                  blockOnUpload: (file) => uploadAsset(base, file),
                },
              }
            : {},
        });
        crepe = editor;
        host.addEventListener("beforeinput", markUserEdited, true);
        host.addEventListener("input", markUserEdited, true);
        host.addEventListener("keydown", markUserEdited, true);
        host.addEventListener("paste", markUserEdited, true);
        host.addEventListener("drop", markUserEdited, true);
        editor.on((listener: { markdownUpdated: (callback: (_ctx: unknown, markdown: string) => void) => void }) => {
          listener.markdownUpdated((_ctx, markdown) => {
            if (!userEdited) {
              return;
            }
            onChangeRef.current(markdown);
          });
        });
        Promise.resolve(editor.create())
          .then(() => {
            if (!cancelled) setLoadState("ready");
          })
          .catch(fail);
      })
      .catch(fail);

    // Crepe renders links as plain <a href> that, when clicked, would navigate
    // the browser to the raw relative href (e.g. features/runs.md) against the
    // gateway page URL → broken. Intercept: external → new tab, same-page anchor
    // → scroll, in-spec link → delegate so the host can open that doc.
    const onClick = (event: MouseEvent) => {
      const node = event.target as HTMLElement | null;
      const anchor = node?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !host.contains(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith("mailto:")) {
        window.open(href, "_blank", "noopener");
        return;
      }
      if (href.startsWith("#")) {
        const target = host.querySelector(`[id="${href.slice(1)}"]`);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      onLinkClickRef.current?.(href);
    };
    host.addEventListener("click", onClick, true);

    return () => {
      cancelled = true;
      host.removeEventListener("beforeinput", markUserEdited, true);
      host.removeEventListener("input", markUserEdited, true);
      host.removeEventListener("keydown", markUserEdited, true);
      host.removeEventListener("paste", markUserEdited, true);
      host.removeEventListener("drop", markUserEdited, true);
      host.removeEventListener("click", onClick, true);
      void crepe?.destroy();
    };
    // Re-initialise only when the selected doc or asset host changes; live edits
    // flow through the listener, not by recreating the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath, assetBase, useTextareaFallback, retryKey, resetKey]);

  if (useTextareaFallback) {
    return (
      <textarea
        className="crepe-host ddd-editor-fallback"
        data-testid="ddd-editor"
        value={fallbackValue}
        aria-label={docPath}
        onInput={(event) => onFallbackInput(event.currentTarget.value)}
        onChange={(event) => onFallbackInput(event.currentTarget.value)}
      />
    );
  }

  return (
    <div className="crepe-shell" data-testid="ddd-editor">
      {loadState === "loading" ? (
        <div className="editor-state" data-testid="ddd-editor-loading" role="status">
          Loading editor...
        </div>
      ) : null}
      {loadState === "failed" ? (
        <div className="editor-failure" data-testid="ddd-editor-error" role="alert">
          <div>
            <strong>Editor failed to load</strong>
            <p>{loadError || "Milkdown Crepe did not initialize. You can keep editing in markdown below."}</p>
          </div>
          <button
            type="button"
            className="button"
            data-testid="ddd-editor-retry"
            onClick={() => setRetryKey((key) => key + 1)}
          >
            Retry editor
          </button>
          <textarea
            className="ddd-editor-fallback editor-fallback"
            data-testid="ddd-editor-fallback"
            value={fallbackValue}
            aria-label={`${docPath} markdown fallback`}
            onInput={(event) => onFallbackInput(event.currentTarget.value)}
            onChange={(event) => onFallbackInput(event.currentTarget.value)}
          />
        </div>
      ) : null}
      <div className={loadState === "failed" ? "crepe-host is-hidden" : "crepe-host"} ref={hostRef} />
    </div>
  );
}

type TreeDir = { name: string; path: string; dirs: TreeDir[]; files: string[] };

/** Group flat `/`-delimited paths into a nested directory tree. */
function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let dir = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!;
      let next = dir.dirs.find((child) => child.name === name);
      if (!next) {
        next = { name, path: dir.path ? `${dir.path}/${name}` : name, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push(path);
  }
  return root;
}

function TreeDirView({
  dir,
  selectedPath,
  dirtyPaths,
  onSelect,
}: {
  dir: TreeDir;
  selectedPath: string;
  dirtyPaths: ReadonlySet<string>;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {dir.dirs.map((child) => (
        <details className="tree-dir" key={child.path} open>
          <summary className="tree-dir-name">{child.name}</summary>
          <div className="tree-children">
            <TreeDirView dir={child} selectedPath={selectedPath} dirtyPaths={dirtyPaths} onSelect={onSelect} />
          </div>
        </details>
      ))}
      {dir.files.map((path) => {
        const dirty = dirtyPaths.has(path);
        return (
          <button
            key={path}
            type="button"
            className={`${path === selectedPath ? "tree-file is-active" : "tree-file"}${dirty ? " is-dirty" : ""}`}
            data-testid="ddd-tree-file"
            title={path}
            onClick={() => onSelect(path)}
          >
            <span className="tree-file-name">{path.split("/").at(-1)}</span>
            {dirty ? <span className="tree-dirty" aria-label="Unsaved changes" title="Unsaved changes" /> : null}
          </button>
        );
      })}
    </>
  );
}

/**
 * Small self-contained file tree (replaces @pierre/trees): paths grouped by
 * directory into collapsible <details>, leaf files are buttons, the selected
 * path is highlighted.
 */
export function SpecFileTree({
  files,
  selectedPath,
  changedPaths = [],
  onSelect,
}: {
  files: ReadonlyArray<{ path: string }>;
  selectedPath: string;
  changedPaths?: ReadonlyArray<string>;
  onSelect: (path: string) => void;
}) {
  const root = buildTree(files.map((file) => file.path));
  const dirtyPaths = new Set(changedPaths);
  return (
    <div className="tree" data-testid="ddd-spec-tree">
      <TreeDirView dir={root} selectedPath={selectedPath} dirtyPaths={dirtyPaths} onSelect={onSelect} />
    </div>
  );
}

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
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
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
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (bullet || ordered) {
      const items: string[] = [];
      const isOrdered = !!ordered;
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(isOrdered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim()) break;
      if (
        /^```/.test(next) ||
        /^#{1,6}\s+/.test(next) ||
        /^>\s?/.test(next) ||
        /^\s*[-*]\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next)
      )
        break;
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

function renderInlineMarkdown(value: string, keyPrefix: string, onLinkClick?: (href: string) => void): ReactNode[] {
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
        nodes.push(
          <code key={`${keyPrefix}:code:${cursor}`}>{value.slice(cursor + 1, end).replace(/\\`/g, "`")}</code>,
        );
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
            {renderInlineMarkdown(value.slice(cursor + 2, end), `${keyPrefix}:strong:${cursor}`, onLinkClick)}
          </strong>,
        );
        cursor = end + 2;
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
                {renderInlineMarkdown(label, `${keyPrefix}:link-label:${cursor}`, onLinkClick)}
              </a>,
            );
          } else {
            nodes.push(
              <button
                key={`${keyPrefix}:link:${cursor}`}
                type="button"
                className="doc-link"
                onClick={() => onLinkClick?.(href)}
              >
                {renderInlineMarkdown(label, `${keyPrefix}:link-label:${cursor}`, onLinkClick)}
              </button>,
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

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function MermaidPreview({ code, index }: { code: string; index: number }) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let alive = true;
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      void Promise.resolve(mermaid.render(`ddd-mermaid-${index}-${hashText(code)}`, code))
        .then((result) => {
          if (!alive || !result) return;
          setSvg(asString(typeof result === "string" ? result : result.svg));
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    } catch {
      if (alive) setFailed(true);
    }
    return () => {
      alive = false;
    };
  }, [code, index]);

  return (
    <div className="mermaid-preview" data-testid="ddd-mermaid-preview">
      <div className="mermaid-title">Diagram preview</div>
      {svg && !failed ? (
        <div className="mermaid-rendered" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <pre className="mermaid-source">{code}</pre>
      )}
    </div>
  );
}

export function MarkdownPreview({ markdown, onLinkClick }: { markdown: string; onLinkClick?: (href: string) => void }) {
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) return <p className="empty">No documentation content.</p>;
  return (
    <div className="markdown-preview" data-testid="ddd-markdown-preview">
      {blocks.map((block, index) => {
        const key = `md:${index}`;
        if (block.type === "heading") {
          if (block.level <= 1) return <h1 key={key}>{renderInlineMarkdown(block.text, key, onLinkClick)}</h1>;
          if (block.level === 2) return <h2 key={key}>{renderInlineMarkdown(block.text, key, onLinkClick)}</h2>;
          return <h3 key={key}>{renderInlineMarkdown(block.text, key, onLinkClick)}</h3>;
        }
        if (block.type === "quote")
          return <blockquote key={key}>{renderInlineMarkdown(block.text, key, onLinkClick)}</blockquote>;
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}:item:${itemIndex}`}>
                  {renderInlineMarkdown(item, `${key}:item:${itemIndex}`, onLinkClick)}
                </li>
              ))}
            </List>
          );
        }
        if (block.type === "code") {
          if (block.lang.toLowerCase() === "mermaid")
            return <MermaidPreview key={key} code={block.code} index={index} />;
          return (
            <pre key={key} className="markdown-code">
              <code>{block.code}</code>
            </pre>
          );
        }
        return <p key={key}>{renderInlineMarkdown(block.text, key, onLinkClick)}</p>;
      })}
    </div>
  );
}

export function WorkflowSource({ workflowKey = "docs-driven-development" }: { workflowKey?: string }) {
  const entry =
    workflowSources[workflowKey] ??
    (workflowKey === "docs-driven-development" ? { path: workflowSourcePath, source: workflowSource } : undefined);
  if (!entry?.source) return null;
  const lineCount = entry.source.split("\n").length;
  // Collapsed by default: the full script is a tall wall that used to split the
  // two live surfaces. The card-head is the <summary> disclosure.
  return (
    <details className="card source-card" data-testid="ddd-workflow-source">
      <summary className="card-head source-summary">
        <h2>Repository script</h2>
        <span className="source-summary-meta">
          <span className="pill">{entry.path}</span>
          <span className="pill muted">{formatCount(lineCount, "line")}</span>
        </span>
      </summary>
      <pre className="source">{entry.source}</pre>
    </details>
  );
}

export function CapabilityBlock({ capabilities }: { capabilities?: FeatureCapability[] }) {
  const caps = capabilities ?? [];
  if (caps.length === 0) return null;
  return (
    <div className="list-block">
      <strong>Capabilities</strong>
      <div className="cap-grid">
        {caps.map((cap, index) => (
          <div className="cap" key={`cap:${index}`}>
            <div className="cap-head">
              <span className="cap-title">{cap.title}</span>
              {cap.status ? (
                <span className={`badge ${statusClass(cap.status)}`}>
                  {statusLabels[cap.status] ?? formatStatus(cap.status)}
                </span>
              ) : null}
            </div>
            <p>{cap.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EndpointBlock({
  endpoints,
  onOpenDoc,
}: {
  endpoints?: FeatureEndpoint[];
  onOpenDoc?: (href: string) => void;
}) {
  const eps = endpoints ?? [];
  if (eps.length === 0) return null;
  return (
    <div className="list-block">
      <strong>API endpoints</strong>
      <ul className="endpoint-list">
        {eps.map((ep, index) => (
          <li key={`ep:${index}`}>
            <code className="endpoint">
              {ep.method} {ep.path}
            </code>
            {ep.note ? <span className="endpoint-note">({ep.note})</span> : null}
            {ep.doc ? (
              <button type="button" className="doc-link" onClick={() => onOpenDoc?.(ep.doc!)}>
                docs ↗
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LinkBlock({ links, onOpenDoc }: { links?: FeatureLink[]; onOpenDoc?: (href: string) => void }) {
  const items = links ?? [];
  if (items.length === 0) return null;
  const isExternal = (href: string) => /^https?:\/\//.test(href);
  return (
    <div className="list-block">
      <strong>Related docs</strong>
      <ul>
        {items.map((link, index) => (
          <li key={`link:${index}`}>
            {isExternal(link.href) ? (
              <a className="doc-link" href={link.href} target="_blank" rel="noreferrer">
                {link.label} ↗
              </a>
            ) : (
              <button type="button" className="doc-link" onClick={() => onOpenDoc?.(link.href)}>
                {link.label} →
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FeatureDetail({
  feature,
  note,
  assetUrl,
  onClose,
  onOpenDoc,
}: {
  feature: Feature;
  note?: string;
  assetUrl: (p?: string) => string | undefined;
  onClose: () => void;
  onOpenDoc?: (href: string) => void;
}) {
  const media = assetUrl(feature.gif) ?? assetUrl(feature.image);
  const tier = feature.tier ?? "feature";
  const modalRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap({ containerRef: modalRef, initialFocusRef: closeRef, onClose });

  const tests = strings(feature.tests);
  const observability = strings(feature.observability);
  const debug = strings(feature.debug);
  const architecture = strings(feature.architecture);
  const evidence = strings(feature.evidence);
  const fixes = [...strings(feature.changes), ...strings(feature.diffHints)];
  const gaps = strings(feature.missing);
  const capabilities = feature.capabilities ?? [];
  const endpoints = feature.endpoints ?? [];
  const links = feature.links ?? [];
  const brokenCaps = capabilities.filter((cap) => cap.status === "broken" || cap.status === "partial").length;

  // Group the ~10 detail blocks into panels so the modal is navigable instead of
  // one long always-expanded scroll. Only non-empty panels get a tab.
  const sections: Array<{ key: string; label: string; count: number; render: () => ReactNode }> = [
    {
      key: "overview",
      label: "Overview",
      count: capabilities.length,
      render: () => (
        <>
          {feature.userValue ? (
            <p className="user-value">
              <strong>What you can do:</strong> {feature.userValue}
            </p>
          ) : null}
          {feature.summary ? <p>{feature.summary}</p> : null}
          <CapabilityBlock capabilities={feature.capabilities} />
        </>
      ),
    },
    {
      key: "verification",
      label: "Verification",
      count: tests.length + observability.length + debug.length + evidence.length,
      render: () => (
        <>
          <DetailList title="Test Cases" items={tests} mono />
          <DetailList title="Evidence" items={evidence} />
          <DetailList title="Observability" items={observability} />
          <DetailList title="Debugging" items={debug} />
        </>
      ),
    },
    {
      key: "docs-api",
      label: "Docs & API",
      count: endpoints.length + links.length + architecture.length,
      render: () => (
        <>
          <EndpointBlock endpoints={feature.endpoints} onOpenDoc={onOpenDoc} />
          <LinkBlock links={feature.links} onOpenDoc={onOpenDoc} />
          <DetailList title="Architecture" items={architecture} />
        </>
      ),
    },
    {
      key: "gaps",
      label: "Gaps & Fixes",
      count: gaps.length + fixes.length,
      render: () => (
        <>
          <DetailList title="Open Gaps" items={gaps} tone="warn" />
          <DetailList title="Fixes & Diffs" items={fixes} mono />
        </>
      ),
    },
  ].filter((section) => section.count > 0);

  const [activeSection, setActiveSection] = useState(sections[0]?.key ?? "overview");
  const current = sections.find((section) => section.key === activeSection) ?? sections[0];

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddd-feature-detail-title"
        tabIndex={-1}
        data-testid="ddd-feature-detail"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">
              {feature.id}
              {feature.group ? ` · ${feature.group}` : ""}
            </span>
            <h2 id="ddd-feature-detail-title">{feature.title}</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="meta-row">
          <span className={`badge ${statusClass(feature.status)}`}>
            {statusLabels[feature.status] ?? feature.status}
          </span>
          <span className="pill">Priority {feature.priority.toUpperCase()}</span>
          <span className="pill">Owner {feature.owner}</span>
          {tier !== "feature" ? <span className="pill">{formatFeatureTier(tier)}</span> : null}
        </div>
        {note ? <p className="audit-note">Audit note: {note}</p> : null}
        {media ? <img className="feature-media" src={media} alt="" /> : null}

        <div className="stats detail-kpis" data-testid="ddd-feature-kpis">
          <div className="stat">
            <strong>{capabilities.length}</strong>
            <span>{brokenCaps ? `Capabilities · ${brokenCaps} at risk` : "Capabilities"}</span>
          </div>
          <div className="stat">
            <strong>{endpoints.length}</strong>
            <span>Endpoints</span>
          </div>
          <div className="stat">
            <strong>{tests.length}</strong>
            <span>Tests</span>
          </div>
          <div className={`stat${gaps.length ? " stat-warn" : ""}`}>
            <strong>{gaps.length}</strong>
            <span>Open gaps</span>
          </div>
        </div>

        {sections.length > 1 ? (
          <div className="preview-toolbar detail-toolbar" role="tablist" aria-label="Feature detail sections">
            {sections.map((section) => (
              <button
                key={section.key}
                type="button"
                role="tab"
                id={`ddd-feature-tab-${section.key}`}
                aria-controls="ddd-feature-detail-panel"
                aria-selected={current?.key === section.key}
                className={current?.key === section.key ? "segmented is-active" : "segmented"}
                data-testid={`ddd-feature-section-${section.key}`}
                onClick={() => setActiveSection(section.key)}
              >
                {section.label}
                <span className="count">{section.count}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div
          className="detail-panel"
          id="ddd-feature-detail-panel"
          data-testid="ddd-feature-detail-panel"
          role={sections.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={sections.length > 1 && current ? `ddd-feature-tab-${current.key}` : undefined}
        >
          {current ? current.render() : <p className="empty">No detail recorded for this feature yet.</p>}
        </div>
      </section>
    </div>
  );
}

/**
 * A titled section whose items render as bordered rows (not muted bullets), so
 * long prose/paths read as scannable cards. `mono` formats items as code
 * (test commands, file paths); `tone` tints the left rail (open gaps → warn).
 */
export function DetailList({
  title,
  items,
  mono = false,
  tone,
}: {
  title: string;
  items: string[];
  mono?: boolean;
  tone?: "warn" | "bad";
}) {
  if (items.length === 0) return null;
  return (
    <div className="list-block">
      <div className="list-block-head">
        <strong>{title}</strong>
        <span className="pill muted">{items.length}</span>
      </div>
      <div className="detail-rows">
        {items.map((item, index) => (
          <div className={`detail-row${tone ? ` is-${tone}` : ""}`} key={`${title}:${index}`}>
            {mono ? <code className="detail-mono">{item}</code> : <span>{item}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Structured count/flag chips for a node-output row (changed files, fixed, etc.). */
export function outputCardChips(
  row: Record<string, unknown> | null,
): Array<{ key: string; label: string; tone: "" | "ok" | "warn" | "bad" }> {
  if (!row) return [];
  const chips: Array<{ key: string; label: string; tone: "" | "ok" | "warn" | "bad" }> = [];
  const countFields: Array<[string, string, string]> = [
    ["changedFiles", "file changed", "files changed"],
    ["updatedFiles", "doc updated", "docs updated"],
    ["updatedDocs", "doc updated", "docs updated"],
    ["featuresUpdated", "feature updated", "features updated"],
    ["fixed", "fixed", "fixed"],
    ["remaining", "remaining", "remaining"],
    ["tickets", "ticket", "tickets"],
    ["findings", "finding", "findings"],
    ["commandsRun", "command", "commands"],
    ["commands", "command", "commands"],
  ];
  for (const [key, singular, plural] of countFields) {
    const count = asArray(row[key]).length;
    if (count > 0)
      chips.push({ key, label: formatCount(count, singular, plural), tone: key === "remaining" ? "warn" : "" });
  }
  if (typeof row.buildPassed === "boolean")
    chips.push({
      key: "build",
      label: row.buildPassed ? "build passed" : "build failed",
      tone: row.buildPassed ? "ok" : "bad",
    });
  if (typeof row.docsBuildPassed === "boolean")
    chips.push({
      key: "docsBuild",
      label: row.docsBuildPassed ? "docs build passed" : "docs build failed",
      tone: row.docsBuildPassed ? "ok" : "bad",
    });
  return chips;
}

export function OutputCard({
  label,
  row,
  pending = "waiting",
}: {
  label: string;
  row: Record<string, unknown> | null;
  pending?: string;
}) {
  const summary = asString(row?.summary);
  const status = asString(row?.status) || (row ? "ready" : "waiting");
  const chips = outputCardChips(row);
  const testId = `ddd-output-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className="card output-card" data-testid={testId}>
      <div className="card-head">
        <h2>{label}</h2>
        <span className={`badge ${statusClass(status)}`}>{formatStatus(status)}</span>
      </div>
      {chips.length ? (
        <div className="meta-row">
          {chips.map((chip) => (
            <span key={chip.key} className={chip.tone ? `badge ${chip.tone}` : "pill"}>
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
      {summary ? <MarkdownPreview markdown={summary} /> : <p className="output-pending">{pending}</p>}
    </section>
  );
}

export const styles = [
  // Design tokens mirror the multi app (src/styles.css): Inter, brand purple,
  // surface/border tokens, light by default + OS dark. Legacy ddd token names
  // (--panel/--card/--line/--muted/--ok/--warn/--bad/--blue) are aliased to the
  // app tokens so every component recolors to match the app at once.
  ":root { color-scheme:light; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
    " --bg:#ffffff; --text:#0a0a0a; --text-muted:#525252; --text-faint:#6f6f6f; --surface:#ffffff;" +
    " --surface-glass:rgba(255,255,255,0.72); --surface-glass-strong:rgba(255,255,255,0.85);" +
    " --border:rgba(10,10,10,0.08); --border-strong:rgba(10,10,10,0.14); --border-solid:#ededed;" +
    " --hover:#f4f4f4; --hover-subtle:rgba(10,10,10,0.03); --inverse-bg:#0a0a0a; --inverse-text:#ffffff;" +
    " --code-bg:#0a0a0a; --code-text:#f4f4f4; --brand:#6d56d8; --success:#087461; --danger:#c5343f; --warning:#955600; --shadow-rgb:10 10 10;" +
    " --panel:var(--surface); --card:var(--surface); --line:var(--border-solid); --muted:var(--text-muted);" +
    " --ok:var(--success); --warn:var(--warning); --bad:var(--danger); --blue:var(--brand); }",
  "@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { color-scheme:dark;" +
    " --bg:#0b0b0d; --text:#f4f4f5; --text-muted:#a1a1aa; --text-faint:#b0b0b8; --surface:#18181b;" +
    " --surface-glass:rgba(24,24,27,0.72); --surface-glass-strong:rgba(24,24,27,0.85);" +
    " --border:rgba(255,255,255,0.1); --border-strong:rgba(255,255,255,0.18); --border-solid:#2a2a2e;" +
    " --hover:#26262b; --hover-subtle:rgba(255,255,255,0.05); --inverse-bg:#f4f4f5; --inverse-text:#0a0a0a;" +
    " --code-bg:#09090b; --code-text:#e4e4e7; --brand:#8b78e6; --success:#2ec9a8; --danger:#f2555a; --warning:#e0a23a; --shadow-rgb:0 0 0; } }",
  ":root[data-theme='dark'] { color-scheme:dark;" +
    " --bg:#0b0b0d; --text:#f4f4f5; --text-muted:#a1a1aa; --text-faint:#b0b0b8; --surface:#18181b;" +
    " --surface-glass:rgba(24,24,27,0.72); --surface-glass-strong:rgba(24,24,27,0.85);" +
    " --border:rgba(255,255,255,0.1); --border-strong:rgba(255,255,255,0.18); --border-solid:#2a2a2e;" +
    " --hover:#26262b; --hover-subtle:rgba(255,255,255,0.05); --inverse-bg:#f4f4f5; --inverse-text:#0a0a0a;" +
    " --code-bg:#09090b; --code-text:#e4e4e7; --brand:#8b78e6; --success:#2ec9a8; --danger:#f2555a; --warning:#e0a23a; --shadow-rgb:0 0 0; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; overflow:hidden; }",
  "button { font:inherit; }",
  ".shell { height:100vh; width:100%; max-width:100vw; overflow:hidden; display:grid; grid-template-rows:auto auto 1fr; }",
  ".top { position:relative; z-index:80; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 18px; border-bottom:1px solid var(--border); background:var(--surface-glass-strong); -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%); }",
  ".title { display:flex; align-items:center; gap:12px; min-width:0; flex:1 1 auto; }",
  "h1 { margin:0; font-size:18px; font-weight:700; letter-spacing:-0.01em; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  "h2 { margin:0; font-size:14px; font-weight:650; color:var(--text); line-height:1.3; }",
  "p { margin:0; color:var(--text); line-height:1.5; }",
  ".eyebrow { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px; }",
  ".pill,.badge { display:inline-flex; align-items:center; min-width:0; max-width:100%; min-height:22px; padding:1px 10px; border:1px solid var(--border); border-radius:999px; font-size:11px; color:var(--text-muted); font-family:ui-monospace,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
  ".pill { border-color:color-mix(in srgb,var(--brand) 22%,transparent); background:color-mix(in srgb,var(--brand) 14%,transparent); color:var(--brand); }",
  ".pill.muted { border-color:var(--border); background:var(--hover-subtle); color:var(--text-muted); }",
  ".badge { text-transform:uppercase; font-family:inherit; font-weight:650; }",
  ".badge.ok { color:var(--ok); border-color:color-mix(in srgb,var(--ok),transparent 55%); background:color-mix(in srgb,var(--ok) 12%,transparent); }",
  ".badge.warn { color:var(--warn); border-color:color-mix(in srgb,var(--warn),transparent 55%); background:color-mix(in srgb,var(--warn) 12%,transparent); }",
  ".badge.bad { color:var(--bad); border-color:color-mix(in srgb,var(--bad),transparent 55%); background:color-mix(in srgb,var(--bad) 12%,transparent); }",
  ".actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }",
  ".new-menu-wrap { position:relative; display:inline-flex; }",
  ".new-menu { position:absolute; top:calc(100% + 8px); right:0; width:min(360px,calc(100vw - 24px)); z-index:55; display:grid; gap:10px; padding:12px; background:var(--surface); border:1px solid var(--border); border-radius:8px; box-shadow:0 18px 56px rgb(var(--shadow-rgb) / 0.18); }",
  ".new-menu-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".new-menu-divider { height:1px; background:var(--border); margin:2px 0; }",
  ".new-menu .button { width:100%; }",
  ".new-menu .start-status { margin-top:-2px; }",
  ".button { border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:6px; min-height:32px; padding:0 12px; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; gap:6px; }",
  ".button:hover { background:var(--hover); }",
  ".button.primary { border-color:color-mix(in srgb,var(--brand) 40%,transparent); background:color-mix(in srgb,var(--brand) 10%,var(--surface)); color:var(--brand); font-weight:650; }",
  ".button.primary:hover { background:color-mix(in srgb,var(--brand) 16%,var(--surface)); }",
  ".button.danger { border-color:color-mix(in srgb,var(--danger) 45%,transparent); color:var(--danger); }",
  ".button.danger:hover { background:color-mix(in srgb,var(--danger) 12%,var(--surface)); }",
  ".button.danger.is-armed { background:color-mix(in srgb,var(--danger) 14%,var(--surface)); font-weight:650; }",
  ".button:focus-visible,.icon-button:focus-visible,.tab:focus-visible,.tree-file:focus-visible,.run-row:focus-visible,.finding:focus-visible,.feature-card.is-clickable:focus-visible,.ticket-row:focus-visible,.doc-link:focus-visible,.tree-dir-name:focus-visible,.tree-section-toggle:focus-visible,.segmented:focus-visible { outline:none; border-color:color-mix(in srgb,var(--brand) 50%,transparent); box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent); }",
  ".button:disabled { cursor:not-allowed; opacity:.45; }",
  ".icon-button { width:32px; min-height:32px; padding:0; border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:6px; cursor:pointer; }",
  ".subhead { min-width:0; }",
  ".subhead[hidden] { display:none; }",
  ".tabbar { min-width:0; display:flex; align-items:center; gap:6px; padding:8px 14px; border-bottom:1px solid var(--border); background:var(--surface); overflow-x:auto; scrollbar-width:thin; }",
  ".tab { flex:0 0 auto; border:1px solid transparent; background:transparent; color:var(--muted); border-radius:6px; min-height:30px; padding:0 12px; cursor:pointer; font-weight:650; display:inline-flex; align-items:center; gap:7px; }",
  ".tab:hover { color:var(--text); }",
  ".tab.is-active { background:color-mix(in srgb,var(--brand) 12%,transparent); border-color:color-mix(in srgb,var(--brand) 30%,transparent); color:var(--brand); }",
  ".tab .count { font-family:ui-monospace,monospace; font-size:10px; color:var(--muted); }",
  // phase-progress stepper: the multi-phase run pipeline (audit>docs>triage>work>summary) made visible in the shell
  ".phasebar { min-width:0; display:flex; align-items:center; list-style:none; margin:0; padding:8px 16px; border-bottom:1px solid var(--border); background:var(--surface); overflow-x:auto; scrollbar-width:thin; }",
  ".phase { flex:0 0 auto; display:inline-flex; align-items:center; gap:7px; color:var(--text-muted); font-size:11px; font-weight:650; white-space:nowrap; }",
  ".phase:not(:last-child)::after { content:''; flex:none; width:22px; height:1px; margin:0 10px; background:var(--border-strong); }",
  ".phase-dot { flex:none; width:9px; height:9px; border-radius:999px; border:1.5px solid var(--border-strong); background:var(--surface); }",
  ".phase.is-done { color:var(--ok); }",
  ".phase.is-done .phase-dot { background:var(--ok); border-color:var(--ok); }",
  ".phase.is-done:not(:last-child)::after { background:color-mix(in srgb,var(--ok) 55%,var(--border-strong)); }",
  ".phase.is-active { color:var(--brand); }",
  ".phase.is-active .phase-dot { border-color:var(--brand); box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 20%,transparent); }",
  ".content { position:relative; min-width:0; min-height:0; overflow:hidden; }",
  ".content > .error-banner { position:absolute; top:10px; left:50%; transform:translateX(-50%); width:min(720px,calc(100% - 24px)); z-index:50; }",
  ".content > [hidden] { display:none; }",
  ".pane { height:100%; min-width:0; min-height:0; }",
  // Specs tab
  ".specs { height:100%; display:grid; grid-template-columns:minmax(220px,260px) minmax(0,1fr); min-height:0; }",
  ".specs-tree { border-right:1px solid var(--border); min-height:0; height:100%; overflow:auto; background:var(--surface); }",
  // built-in file tree (replaces @pierre/trees)
  ".tree { padding:8px; display:grid; align-content:start; gap:2px; }",
  ".tree-dir { display:grid; gap:2px; }",
  ".tree-dir-name { cursor:pointer; color:var(--muted); font-weight:650; font-size:12px; padding:4px 6px; border-radius:6px; list-style:revert; }",
  ".tree-dir-name:hover { color:var(--text); background:var(--hover-subtle); }",
  ".tree-children { display:grid; gap:2px; padding-left:12px; }",
  ".tree-file { min-width:0; border:1px solid transparent; background:transparent; color:var(--text); text-align:left; border-radius:6px; padding:4px 8px; cursor:pointer; font-size:12px; font-family:ui-monospace,monospace; display:flex; align-items:center; gap:6px; overflow:hidden; white-space:nowrap; }",
  ".tree-file-name { min-width:0; overflow:hidden; text-overflow:ellipsis; }",
  ".tree-dirty { flex:none; width:7px; height:7px; border-radius:999px; background:var(--warn); box-shadow:0 0 0 2px color-mix(in srgb,var(--warn) 18%,transparent); }",
  ".tree-file:hover { background:var(--hover); }",
  ".tree-file.is-active { background:color-mix(in srgb,var(--blue) 16%,transparent); border-color:color-mix(in srgb,var(--blue) 35%,transparent); color:var(--text); }",
  ".specs-main { min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }",
  ".editor-bar { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid var(--border); background:var(--surface); }",
  ".editor-title { min-width:0; display:flex; align-items:center; gap:8px; }",
  ".editor-bar .path { font-family:ui-monospace,monospace; font-size:12px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  ".dispatch-actions { display:flex; align-items:center; gap:8px; min-width:0; }",
  ".crepe-shell { min-height:0; min-width:0; overflow:hidden; display:grid; grid-template-rows:minmax(0,1fr); position:relative; background:var(--surface); }",
  ".crepe-host { min-height:0; overflow:auto; }",
  ".crepe-shell .crepe-host { height:100%; }",
  ".crepe-host.is-hidden { display:none; }",
  ".editor-state { position:absolute; inset:0; display:grid; place-items:center; padding:24px; color:var(--text-muted); background:var(--surface); z-index:1; }",
  ".editor-failure { min-height:0; overflow:auto; display:grid; align-content:start; gap:12px; padding:16px; background:var(--surface); }",
  ".editor-failure strong { color:var(--danger); font-size:13px; }",
  ".editor-failure .button { justify-self:start; }",
  ".ddd-editor-fallback { width:100%; height:100%; resize:none; border:0; padding:16px; background:var(--surface); color:var(--text); font:13px/1.5 ui-monospace,monospace; }",
  ".editor-failure .editor-fallback { min-height:320px; border:1px solid var(--border); border-radius:8px; }",
  ".crepe-host .milkdown { height:100%; }",
  ".empty { display:grid; place-items:center; align-content:center; text-align:center; gap:6px; min-height:160px; padding:24px; color:var(--text-muted); }",
  ".meta-status { display:flex; align-items:center; gap:10px; padding:10px 14px; border-top:1px solid var(--line); color:var(--muted); }",
  ".error-banner { min-width:0; display:grid; gap:4px; border:1px solid color-mix(in srgb,var(--danger) 55%,transparent); border-radius:8px; padding:10px 12px; background:color-mix(in srgb,var(--danger) 9%,var(--surface)); color:var(--text); box-shadow:0 10px 32px rgb(var(--shadow-rgb) / 0.12); }",
  ".error-banner strong { color:var(--danger); font-size:12px; }",
  ".error-banner p { color:var(--text); font-size:12px; overflow-wrap:anywhere; }",
  // generic scroll column
  ".scroll { height:100%; min-width:0; overflow:auto; padding:14px; display:grid; align-content:start; gap:12px; }",
  ".card { min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:14px; display:grid; gap:8px; box-shadow:0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.06); }",
  ".card-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }",
  ".stat { min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:10px; text-align:left; cursor:default; }",
  ".stat strong { display:block; font-size:18px; }",
  ".stat span { color:var(--muted); font-size:11px; }",
  ".grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; align-items:start; }",
  // OutputCard: render its summary as compact markdown (not an article) and keep
  // the pending placeholder visibly muted so it never reads as real output.
  ".output-card .markdown-preview { padding:0; background:transparent; overflow:visible; }",
  ".output-card .markdown-preview > *:first-child { margin-top:0; }",
  ".output-card .markdown-preview > *:last-child { margin-bottom:0; }",
  ".output-card .markdown-preview p,.output-card .markdown-preview li { font-size:12px; line-height:1.5; color:var(--text); }",
  ".output-card .markdown-preview p { margin:0 0 6px; max-width:none; }",
  ".output-card .markdown-preview h1 { font-size:13px; margin:8px 0 4px; line-height:1.3; }",
  ".output-card .markdown-preview h2 { font-size:12px; margin:8px 0 4px; }",
  ".output-card .markdown-preview h3 { font-size:12px; margin:6px 0 3px; }",
  ".output-card .markdown-preview ul,.output-card .markdown-preview ol { margin:0 0 6px; padding-left:18px; }",
  ".output-pending { color:var(--text-muted); font-style:italic; }",
  // audit findings
  ".finding { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; border:1px solid var(--border); border-radius:8px; padding:9px 11px; background:var(--surface); cursor:pointer; text-align:left; color:var(--text); width:100%; transition:border-color .12s ease, background .12s ease; }",
  ".finding:hover { background:var(--hover); border-color:var(--border-strong); }",
  ".finding .fid { font-family:ui-monospace,monospace; font-size:12px; }",
  ".unresolved-finding { display:grid; align-items:start; justify-content:stretch; cursor:default; border-color:color-mix(in srgb,var(--warning) 45%,var(--border)); background:color-mix(in srgb,var(--warning) 8%,var(--surface)); }",
  ".unresolved-finding:hover { background:color-mix(in srgb,var(--warning) 8%,var(--surface)); border-color:color-mix(in srgb,var(--warning) 45%,var(--border)); }",
  ".unresolved-finding-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".unresolved-finding p { overflow-wrap:anywhere; }",
  ".unresolved-finding strong { color:var(--text); }",
  ".status-counts { display:flex; flex-wrap:wrap; gap:6px; }",
  ".filters { display:grid; grid-template-columns:minmax(180px,1fr) repeat(2,minmax(150px,auto)) auto; gap:8px; align-items:end; min-width:0; }",
  ".ticket-filters { grid-template-columns:minmax(180px,1fr) repeat(4,minmax(132px,auto)) auto; }",
  ".filter-field { min-width:0; display:grid; gap:4px; color:var(--text-muted); font-size:11px; font-weight:650; }",
  ".search-input,.select { min-width:0; width:100%; height:32px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); padding:0 10px; font:inherit; }",
  ".search-input:focus,.select:focus { outline:none; border-color:color-mix(in srgb,var(--brand) 45%,transparent); box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 20%,transparent); }",
  ".feature-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:8px; }",
  ".feature-card { min-width:0; border:1px solid var(--border); border-radius:8px; padding:10px; display:grid; gap:7px; background:var(--surface); }",
  ".feature-card.is-clickable { cursor:pointer; text-align:left; color:var(--text); width:100%; transition:border-color .12s ease, background .12s ease; }",
  ".feature-card.is-clickable:hover { background:var(--hover); border-color:color-mix(in srgb,var(--brand) 45%,transparent); }",
  ".feature-card-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".feature-card-head strong { min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; }",
  ".feature-card-summary { min-width:0; color:var(--text-muted); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }",
  ".feature-card-foot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }",
  ".tier-section { display:grid; gap:10px; }",
  ".tier-head { display:flex; align-items:center; gap:10px; }",
  ".tier-head h2 { font-size:15px; }",
  ".tier-blurb { margin-top:-4px; color:var(--text-muted); }",
  ".group-block { display:grid; gap:7px; }",
  ".group-title { margin:6px 0 2px; font-size:11px; font-weight:650; color:var(--blue); text-transform:uppercase; letter-spacing:.05em; }",
  ".feature-media { width:100%; border-radius:8px; border:1px solid var(--border); }",
  ".slot { min-width:0; border:1px solid var(--border); border-radius:8px; padding:10px; display:grid; gap:7px; background:var(--surface); }",
  ".ticket-row { width:100%; text-align:left; cursor:pointer; color:var(--text); font:inherit; transition:border-color .12s ease, background .12s ease; }",
  ".ticket-row:hover { border-color:var(--border-strong); background:var(--hover); }",
  ".ticket-row.risk-bad { border-color:color-mix(in srgb,var(--danger) 48%,var(--border)); box-shadow:inset 3px 0 0 var(--danger); }",
  ".ticket-row.risk-warn { border-color:color-mix(in srgb,var(--warning) 42%,var(--border)); box-shadow:inset 3px 0 0 var(--warning); }",
  ".slot-title { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".slot-title strong { min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; }",
  ".meta-row { min-width:0; max-width:100%; display:flex; align-items:center; gap:6px; flex-wrap:wrap; overflow:hidden; }",
  ".meta-row > .pill,.meta-row > .badge { min-width:0; max-width:100%; flex:0 1 auto; }",
  ".ticket-path { flex:1 1 auto; max-width:min(100%, 52ch); }",
  ".audit-note { color:var(--warn); }",
  ".code { display:block; min-width:0; overflow:auto; white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:11px; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:9px; }",
  ".source { display:block; min-width:0; max-width:100%; max-height:480px; overflow:auto; white-space:pre; font-family:ui-monospace,monospace; font-size:11px; line-height:1.5; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:12px; }",
  ".source-card { padding:0; }",
  ".source-card > .source { margin:0 14px 14px; }",
  ".source-summary { cursor:pointer; padding:14px; list-style:none; user-select:none; }",
  ".source-summary::-webkit-details-marker { display:none; }",
  ".source-summary::before { content:'▸'; color:var(--text-faint); font-size:11px; margin-right:2px; transition:transform .12s ease; }",
  ".source-card[open] .source-summary::before { transform:rotate(90deg); }",
  ".source-summary-meta { display:flex; align-items:center; gap:6px; min-width:0; }",
  ".source-summary:hover h2 { color:var(--brand); }",
  ".list-block { display:grid; gap:6px; }",
  ".list-block strong { color:var(--text); font-size:12px; }",
  ".list-block-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  // FeatureDetail: KPI header, segmented section tabs, and bordered detail rows
  ".detail-kpis { grid-template-columns:repeat(4,minmax(0,1fr)); }",
  ".detail-kpis .stat strong { font-size:20px; }",
  ".detail-kpis .stat.stat-warn { border-color:color-mix(in srgb,var(--warning) 45%,var(--border)); background:color-mix(in srgb,var(--warning) 7%,var(--surface)); }",
  ".detail-kpis .stat.stat-warn strong { color:var(--warn); }",
  ".detail-toolbar { justify-content:flex-start; flex-wrap:wrap; border-bottom:1px solid var(--border); padding:0 0 10px; }",
  ".detail-toolbar .segmented { display:inline-flex; align-items:center; gap:6px; }",
  ".detail-toolbar .segmented .count { font-family:ui-monospace,monospace; font-size:10px; opacity:.75; }",
  ".detail-panel { display:grid; gap:12px; }",
  ".detail-rows { display:grid; gap:5px; }",
  ".detail-row { min-width:0; border:1px solid var(--border); border-left:3px solid var(--border-strong); border-radius:6px; padding:7px 10px; background:var(--surface); font-size:12px; line-height:1.5; color:var(--text); overflow-wrap:anywhere; }",
  ".detail-row.is-warn { border-left-color:var(--warn); background:color-mix(in srgb,var(--warning) 6%,var(--surface)); }",
  ".detail-row.is-bad { border-left-color:var(--bad); background:color-mix(in srgb,var(--danger) 6%,var(--surface)); }",
  ".detail-mono { font-family:ui-monospace,monospace; font-size:11px; color:var(--text); background:transparent; border:0; padding:0; }",
  "ul { margin:0; padding-left:18px; color:var(--text); line-height:1.5; }",
  ".user-value { color:var(--text); }",
  ".user-value strong { color:var(--blue); }",
  ".cap-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:8px; }",
  ".cap { min-width:0; border:1px solid var(--border); border-radius:8px; padding:9px 10px; background:var(--surface); display:grid; gap:5px; }",
  ".cap-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".cap-title { color:var(--text); font-weight:650; font-size:12px; }",
  ".endpoint-list { list-style:none; padding-left:0; display:grid; gap:5px; }",
  ".endpoint-list li { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }",
  ".endpoint { font-family:ui-monospace,monospace; font-size:11px; color:var(--text); background:color-mix(in srgb,var(--text) 7%,transparent); border:1px solid var(--border); border-radius:6px; padding:2px 7px; }",
  ".endpoint-note { color:var(--muted); }",
  ".doc-link { border:1px solid color-mix(in srgb,var(--blue),transparent 55%); background:transparent; color:var(--blue); border-radius:6px; padding:1px 8px; font-size:11px; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; }",
  ".doc-link:hover { background:color-mix(in srgb,var(--blue) 14%, transparent); }",
  // live tab
  ".live { height:100%; min-width:0; display:grid; grid-template-columns:minmax(240px,300px) minmax(0,1fr); min-height:0; }",
  ".runlist { min-width:0; border-right:1px solid var(--border); min-height:0; height:100%; overflow:auto; padding:10px; display:grid; align-content:start; gap:6px; background:var(--surface); }",
  ".run-filters { min-width:0; display:grid; grid-template-columns:minmax(0,1fr); gap:6px; padding:2px 0 6px; }",
  ".run-filters .button { width:100%; }",
  ".run-row { min-width:0; border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--surface); cursor:pointer; display:grid; gap:4px; text-align:left; color:var(--text); width:100%; transition:border-color .12s ease, background .12s ease; }",
  ".run-row:hover { background:var(--hover); }",
  ".run-row.is-active { border-color:color-mix(in srgb,var(--brand) 40%,transparent); background:color-mix(in srgb,var(--brand) 8%,var(--surface)); }",
  ".run-row .rid { font-family:ui-monospace,monospace; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  ".livelog { max-height:340px; overflow:auto; background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:8px; font-family:ui-monospace,monospace; font-size:11px; line-height:1.55; }",
  ".livelog-line { display:grid; gap:2px; padding:2px 0; white-space:pre-wrap; word-break:break-word; }",
  ".livelog-main { min-width:0; display:flex; gap:8px; }",
  ".livelog-event { color:var(--blue); flex:none; }",
  ".livelog-node { color:var(--warn); flex:none; }",
  ".livelog-detail { color:var(--code-text); min-width:0; }",
  // tone accents so failures/waits stand out in the streaming feed
  ".livelog-line.is-bad { border-left:2px solid var(--bad); padding-left:6px; margin-left:-8px; }",
  ".livelog-line.is-bad .livelog-event { color:var(--bad); }",
  ".livelog-line.is-warn { border-left:2px solid var(--warn); padding-left:6px; margin-left:-8px; }",
  ".livelog-line.is-warn .livelog-event { color:var(--warn); }",
  ".livelog-line.is-ok .livelog-event { color:var(--ok); }",
  ".chat { display:grid; gap:8px; }",
  ".chat-line { min-width:0; border:1px solid var(--border); border-left:3px solid var(--border-strong); border-radius:8px; padding:8px 10px; background:var(--surface); }",
  ".chat-line .who { color:var(--blue); font-family:ui-monospace,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.05em; }",
  ".chat-line pre { margin:4px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font-family:ui-monospace,monospace; font-size:11px; color:var(--text); }",
  // Assistant/user prose renders through MarkdownPreview, not an 11px monospace
  // slab. Neutralize the preview's article padding and compact its type scale so
  // a chat turn reads like prose but stays dense inside the bubble.
  ".chat-line .markdown-preview { margin:4px 0 0; padding:0; background:transparent; overflow:visible; }",
  ".chat-line .markdown-preview > *:first-child { margin-top:0; }",
  ".chat-line .markdown-preview > *:last-child { margin-bottom:0; }",
  ".chat-line .markdown-preview p,.chat-line .markdown-preview li,.chat-line .markdown-preview blockquote { font-size:13px; line-height:1.55; color:var(--text); }",
  ".chat-line .markdown-preview p { margin:0 0 8px; max-width:none; }",
  ".chat-line .markdown-preview h1 { font-size:15px; margin:10px 0 6px; line-height:1.3; }",
  ".chat-line .markdown-preview h2 { font-size:14px; margin:10px 0 5px; }",
  ".chat-line .markdown-preview h3 { font-size:13px; margin:8px 0 4px; }",
  ".chat-line .markdown-preview ul,.chat-line .markdown-preview ol { margin:0 0 8px; padding-left:20px; }",
  ".chat-line .markdown-preview pre.markdown-code { margin:6px 0; font-size:11px; }",
  // Tint the accent + who-label by role/kind so assistant turns read distinctly
  // from the user, raw node output, and reasoning. Tokens keep light/dark safe.
  ".chat-line.chat-role-assistant { border-left-color:var(--brand); }",
  ".chat-line.chat-role-assistant .who { color:var(--brand); }",
  ".chat-line.chat-role-user { border-left-color:var(--text-muted); }",
  ".chat-line.chat-role-user .who { color:var(--text-muted); }",
  ".chat-line.chat-role-reasoning { border-left-color:var(--text-faint); }",
  ".chat-line.chat-role-reasoning .who { color:var(--text-faint); }",
  ".chat-line.chat-role-reasoning pre { color:var(--text-muted); font-style:italic; }",
  ".chat-line.chat-kind-output { border-left-color:var(--warn); }",
  ".chat-line.chat-kind-output .who { color:var(--warn); }",
  ".chat-line.chat-kind-tool { border-left-color:var(--text-faint); }",
  ".chat-line.chat-kind-tool .who { color:var(--text-faint); }",
  ".nodetree ul { list-style:none; padding-left:14px; }",
  ".nodetree > ul { padding-left:0; }",
  ".nodetree ul ul { border-left:1px solid var(--border); margin-left:4px; padding-left:12px; }",
  ".nodetree li { margin:3px 0; }",
  ".nodetree .node-row { display:flex; align-items:center; gap:8px; width:100%; text-align:left; border:1px solid transparent; border-radius:6px; padding:4px 6px; background:transparent; color:var(--text); cursor:pointer; font:inherit; transition:border-color .12s ease, background .12s ease; }",
  ".nodetree button.node-row:hover { background:var(--hover); border-color:var(--border-strong); }",
  ".nodetree .node-name { color:var(--text); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  ".nodetree .node-drill { margin-left:auto; color:var(--text-faint); flex:none; }",
  // node-tree health tally
  ".tree-tally { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }",
  ".ticket-detail-body { min-width:0; max-width:100%; display:grid; gap:10px; overflow-x:hidden; }",
  ".ticket-section { display:grid; gap:6px; }",
  ".ticket-section h3 { margin:0; font-size:12px; }",
  ".ticket-section p { color:var(--text); overflow-wrap:anywhere; }",
  ".ticket-body .markdown-preview { padding:0; background:transparent; overflow:visible; }",
  ".ticket-body .markdown-preview > *:first-child { margin-top:0; }",
  ".ticket-body .markdown-preview h1 { font-size:16px; }",
  ".ticket-body .markdown-preview h2 { font-size:14px; margin:14px 0 6px; }",
  ".ticket-body .markdown-preview h3 { font-size:13px; }",
  ".ticket-body .markdown-preview p,.ticket-body .markdown-preview li { font-size:13px; }",
  // clickable backlog severity tally
  ".ticket-tally { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }",
  ".ticket-tally .tally-chip { cursor:pointer; background:transparent; font:inherit; }",
  ".ticket-tally .tally-chip.is-active { box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 30%,transparent); }",
  ".ticket-meta-grid { min-width:0; max-width:100%; display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; }",
  ".ticket-meta { min-width:0; border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--hover-subtle); display:grid; gap:3px; }",
  ".ticket-meta span { color:var(--text-muted); font-size:10px; text-transform:uppercase; letter-spacing:.06em; font-weight:650; }",
  ".ticket-meta strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; color:var(--text); }",
  ".modal-backdrop { position:fixed; inset:0; background:rgb(var(--shadow-rgb) / 0.5); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); display:grid; place-items:center; padding:20px; z-index:60; overflow:hidden; }",
  ".modal { min-width:0; width:min(760px,calc(100vw - 40px)); max-height:86vh; overflow-y:auto; overflow-x:hidden; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:18px; display:grid; gap:13px; box-shadow:0 24px 80px rgb(var(--shadow-rgb) / 0.2); }",
  ".modal .meta-row { align-items:flex-start; }",
  ".modal .ticket-path { max-width:100%; }",
  ".modal-head { min-width:0; display:flex; align-items:start; justify-content:space-between; gap:12px; }",
  ".modal-head > div { min-width:0; }",
  ".modal-head h2 { font-size:16px; line-height:1.25; overflow-wrap:anywhere; }",
  // docs tree sections: product docs first-class, technical docs behind a menu
  ".badge.muted { color:var(--text-muted); background:var(--hover-subtle); border-color:var(--border); }",
  ".tree-section { padding:6px 8px 2px; display:grid; gap:2px; }",
  ".doc-tree-search { display:grid; gap:4px; padding:10px 10px 6px; color:var(--text-muted); font-size:11px; font-weight:650; }",
  ".tree-section .tree { padding:2px 0; }",
  ".tree-section-title { display:flex; align-items:center; gap:6px; color:var(--text-muted); font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.06em; padding:4px 6px; }",
  ".tree-section-toggle { cursor:pointer; border-radius:6px; list-style:revert; }",
  ".tree-section-toggle:hover { color:var(--text); background:var(--hover-subtle); }",
  ".tree-section-title .count { font-family:ui-monospace,monospace; font-size:10px; }",
  ".tree-empty { padding:4px 6px; font-size:11px; color:var(--text-muted); }",
  ".agent-docs-callout { margin:4px 6px 6px; padding:8px 10px; font-size:11px; line-height:1.5; color:var(--text-muted); border:1px solid color-mix(in srgb,var(--brand) 30%,transparent); border-radius:8px; background:color-mix(in srgb,var(--brand) 7%,var(--surface)); }",
  ".technical-doc-shell { min-height:0; height:100%; display:grid; grid-template-rows:auto minmax(0,1fr); background:var(--surface); }",
  ".preview-toolbar { display:flex; align-items:center; justify-content:flex-end; gap:4px; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--surface); }",
  ".segmented { min-height:28px; border:1px solid var(--border); background:var(--surface); color:var(--text-muted); border-radius:6px; padding:0 10px; cursor:pointer; font:inherit; font-size:12px; }",
  ".segmented:hover { background:var(--hover); color:var(--text); }",
  ".segmented.is-active { border-color:color-mix(in srgb,var(--brand) 38%,transparent); background:color-mix(in srgb,var(--brand) 12%,var(--surface)); color:var(--brand); font-weight:650; }",
  ".markdown-preview { min-height:0; overflow:auto; padding:22px clamp(18px,4vw,48px); display:block; background:var(--surface); }",
  ".markdown-preview h1 { margin:0 0 14px; width:auto; white-space:normal; overflow:visible; text-overflow:clip; font-size:22px; line-height:1.2; }",
  ".markdown-preview h2 { margin:22px 0 8px; font-size:16px; line-height:1.3; }",
  ".markdown-preview h3 { margin:18px 0 7px; font-size:13px; line-height:1.35; }",
  ".markdown-preview p,.markdown-preview li,.markdown-preview blockquote { color:var(--text); font-size:13px; line-height:1.65; overflow-wrap:anywhere; }",
  ".markdown-preview p { margin:0 0 10px; max-width:82ch; }",
  ".markdown-preview ul,.markdown-preview ol { margin:0 0 12px; padding-left:22px; color:var(--text); }",
  ".markdown-preview code { font-family:ui-monospace,monospace; font-size:.92em; color:var(--text); background:color-mix(in srgb,var(--text) 8%,transparent); border:1px solid var(--border); border-radius:5px; padding:1px 4px; }",
  ".markdown-preview blockquote { margin:0 0 12px; padding:8px 12px; border-left:3px solid color-mix(in srgb,var(--brand) 45%,transparent); background:color-mix(in srgb,var(--brand) 7%,var(--surface)); border-radius:0 8px 8px 0; }",
  ".markdown-code,.mermaid-source,.technical-doc-source { max-height:none; white-space:pre-wrap; overflow-wrap:anywhere; }",
  ".markdown-code { margin:0 0 12px; overflow:auto; font-family:ui-monospace,monospace; font-size:12px; line-height:1.55; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:12px; }",
  ".markdown-code code { background:transparent; border:0; border-radius:0; color:inherit; font:inherit; padding:0; }",
  ".mermaid-preview { margin:0 0 14px; border:1px solid var(--border); border-radius:8px; background:var(--hover-subtle); overflow:hidden; }",
  ".mermaid-title { padding:8px 10px; border-bottom:1px solid var(--border); color:var(--text-muted); font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.06em; }",
  ".mermaid-rendered { padding:14px; overflow:auto; background:var(--surface); }",
  ".mermaid-rendered svg { max-width:100%; height:auto; }",
  ".mermaid-source { margin:0; overflow:auto; padding:12px; font-family:ui-monospace,monospace; font-size:12px; line-height:1.55; color:var(--text); background:var(--surface); }",
  ".technical-doc-source { height:100%; border:0; border-radius:0; }",
  // start pane (the way in: create a new app / generate docs from code)
  ".start.scroll { max-width:960px; margin:0 auto; width:100%; }",
  ".start-intro p { max-width:64ch; }",
  ".start-textarea { min-height:88px; height:auto; padding:8px 10px; resize:vertical; font:inherit; line-height:1.45; }",
  ".start-actions { display:flex; align-items:center; gap:8px; }",
  ".start-status { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:12px; }",
  ".draft-run-state { align-items:flex-start; flex-wrap:wrap; }",
  ".draft-run-state .button { margin-left:auto; flex:none; }",
  ".draft-run-state strong { color:var(--text); }",
  // guided tutorial overlay
  ".tutorial-backdrop { position:fixed; inset:0; background:rgb(var(--shadow-rgb) / 0.5); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); display:grid; place-items:center; padding:20px; z-index:70; }",
  ".tutorial-card { width:min(620px,calc(100vw - 40px)); max-height:86vh; overflow:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:20px; display:grid; gap:12px; box-shadow:0 24px 80px rgb(var(--shadow-rgb) / 0.2); }",
  ".tutorial-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".tutorial-head-actions { display:flex; align-items:center; gap:8px; }",
  ".tutorial-title { font-size:16px; }",
  ".tutorial-body { color:var(--text); line-height:1.55; }",
  ".tutorial-sample { max-height:220px; }",
  ".tutorial-sample-card { display:grid; gap:8px; }",
  ".tutorial-sample-card .feature-card { background:var(--hover-subtle); }",
  ".tutorial-sample-gap { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text); }",
  ".tutorial-sample-source summary { cursor:pointer; color:var(--text-muted); font-size:11px; font-weight:650; }",
  ".tutorial-sample-source[open] summary { margin-bottom:6px; }",
  ".tutorial-sample-source .tutorial-sample { margin:0; }",
  ".tutorial-hint { font-size:12px; color:var(--text-muted); border-left:3px solid color-mix(in srgb,var(--brand) 45%,transparent); padding-left:10px; }",
  ".tutorial-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".tutorial-steps-nav { display:flex; align-items:center; gap:8px; }",
  "@media (max-width: 980px) { .specs,.live { grid-template-columns:1fr; } .specs-tree,.runlist { border-right:0; border-bottom:1px solid var(--border); max-height:220px; } }",
  "@media (max-width: 620px) { .shell { height:100dvh; } .top { align-items:flex-start; flex-wrap:wrap; padding:10px 12px; gap:10px; } .title { flex-wrap:wrap; gap:8px; } h1 { width:100%; } .actions { width:100%; justify-content:flex-start; } .new-menu-wrap { width:100%; } .new-menu { left:0; right:auto; width:calc(100vw - 24px); } .tabbar { padding:8px 10px; } .scroll { padding:10px; } .card { padding:12px; } .card-head { align-items:flex-start; flex-wrap:wrap; } .stats,.grid2 { grid-template-columns:1fr; } .feature-grid,.cap-grid { grid-template-columns:minmax(0,1fr); } .filters { grid-template-columns:1fr; } .editor-bar { align-items:flex-start; flex-wrap:wrap; } .editor-title { width:100%; } .dispatch-actions { width:100%; display:grid; grid-template-columns:1fr; } .button { width:100%; } .specs-tree,.runlist { max-height:190px; } .slot-title { align-items:flex-start; } .modal-backdrop { padding:10px; place-items:start center; } .modal { width:calc(100vw - 20px); max-height:calc(100dvh - 20px); padding:14px; } }",
].join("\n");

/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { featuresData } from "./ddd-features.generated";
import { workflowSource, workflowSourcePath } from "./ddd-workflowSource.generated";
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
export type EventFrame = { type?: string; event?: string; payload?: unknown; seq: number; stateVersion?: number };
export type TicketRow = Record<string, unknown> & {
  path: string;
  kind?: string;
  content?: string;
  status?: string | null;
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
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get(name) ?? undefined;
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
  return labels[normalized] ?? normalized.split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

export function statusClass(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (["fixed", "ready", "done", "finished", "success", "ok", "complete", "completed", "closed"].includes(normalized)) return "ok";
  if (["broken", "blocked", "failed", "failure", "error"].includes(normalized)) return "bad";
  if (
    ["partial", "missing-tests", "missing", "running", "pending", "queued", "waiting", "cancelled", "canceled", "todo", "open"].includes(normalized) ||
    normalized.startsWith("waiting-")
  ) return "warn";
  return "muted";
}

export function fmtTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return asString(error);
}

export function ErrorBanner({ title, errors }: { title: string; errors: unknown[] }) {
  const messages = [...new Set(errors.map(errorMessage).map((message) => message.trim()).filter(Boolean))];
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

export function normalizeMarkdownForDirty(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
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
  if (event === "agent.trace") {
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
    const detailType = action && isRecord(action.detail) ? asString((action.detail as Record<string, unknown>).type) : "";
    const title = action ? asString(action.title) : "";
    const entryType = asString(agentEvent.entryType);

    // CLI agents (codex/claude-code) wrap everything in an `action` envelope where
    // the conversational text lives in `.message`, the real category in
    // `action.kind` / `entryType` / `action.detail.type`. The assistant's words
    // arrive as an `agent_message` (entryType "message"); command/tool/turn/warning
    // activity stays in the Live log so the chat reads like a real conversation.
    if (type === "action") {
      const message = asString(agentEvent.message);
      const isAssistantMessage =
        detailType === "agent_message" || title === "assistant" || entryType === "message";
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

/**
 * Build a clean, de-duplicated conversation for the Chat logs panel.
 *
 * `agent.session` events fire repeatedly, each carrying the CUMULATIVE transcript,
 * so rendering every one would repeat the whole conversation N times. We therefore
 * take the single most-complete transcript (most messages, tie → highest seq) as the
 * conversation, then append any `agent.event` / `task.output` text lines that the
 * transcript doesn't already contain (streaming fragments subsumed by a transcript
 * message are dropped).
 */
export function buildChatLines(frames: EventFrame[]): ChatLine[] {
  const sessionEventOf = (frame: EventFrame): string => {
    return frameEnvelope(frame)?.event ?? "";
  };
  const isSession = (frame: EventFrame): boolean => {
    const event = sessionEventOf(frame);
    return event === "agent.session" || event === "AgentSessionEvent";
  };

  let best: { seq: number; lines: ChatLine[] } | null = null;
  for (const frame of frames) {
    if (!isSession(frame)) continue;
    const candidate = chatLinesFromFrame(frame);
    const seq = Number(frame.seq ?? 0);
    if (!best || candidate.length > best.lines.length || (candidate.length === best.lines.length && seq > best.seq)) {
      best = { seq, lines: candidate };
    }
  }

  const result: ChatLine[] = [];
  const seen = new Set<string>();
  const sessionBlob = best ? best.lines.map((line) => normalizeChatText(line.text)).join("\n") : "";
  if (best) {
    for (const line of best.lines) {
      result.push(line);
      seen.add(normalizeChatText(line.text));
    }
  }
  for (const frame of frames) {
    if (isSession(frame)) continue;
    for (const line of chatLinesFromFrame(frame)) {
      const key = normalizeChatText(line.text);
      if (!key || seen.has(key)) continue;
      if (sessionBlob && sessionBlob.includes(key)) continue; // streaming fragment already in transcript
      seen.add(key);
      result.push(line);
    }
  }
  return result;
}

/**
 * Generic one-line view of any run event for the live log (the `smithers up
 * --interactive` style feed). Renders every public event, not just agent text.
 */
export function logLineFromFrame(frame: EventFrame): { seq: number; event: string; node: string; detail: string } | null {
  const env = frameEnvelope(frame);
  if (!env) return null;
  const { event, payload } = env;
  if (!event || event === "run.heartbeat" || event === "task.heartbeat") return null;
  const node = asString(payload.nodeId ?? payload.node ?? payload.id);
  const trace = isRecord(payload.trace) ? payload.trace : undefined;
  const tracePayload = trace && isRecord(trace.payload) ? trace.payload : undefined;
  const agentEvent = isRecord(payload.event) ? payload.event : undefined;
  const detail =
    asString(payload.output) ||
    asString(payload.text) ||
    (agentEvent ? asString(agentEvent.message) : "") ||
    (tracePayload ? asString(tracePayload.text) : "") ||
    asString(payload.status) ||
    asString(payload.message) ||
    "";
  return { seq: Number(frame.seq ?? 0), event, node, detail: detail.slice(0, 600) };
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
  assetBase,
  onChange,
  onLinkClick,
}: {
  docPath: string;
  initialValue: string;
  /** Undefined when the page has no ?assetBaseUrl — image upload is disabled. */
  assetBase: string | undefined;
  onChange: (markdown: string) => void;
  /** Called for relative (in-spec) link clicks; external + same-page anchors are handled here. */
  onLinkClick?: (href: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const useTextareaFallback =
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !document?.createElement ||
    (typeof navigator !== "undefined" && /happy-dom|jsdom|bun/i.test(navigator.userAgent));

  useEffect(() => {
    if (useTextareaFallback) return;
    const host = hostRef.current;
    if (!host) return;
    const base = assetBase;
    let cancelled = false;
    let crepe: { destroy: () => unknown } | null = null;
    let userEdited = false;
    const markUserEdited = () => {
      userEdited = true;
    };

    void import("@milkdown/crepe").then(({ Crepe }) => {
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
      void editor.create();
    });

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
        window.open(href, "_blank", "noopener,noreferrer");
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
  }, [docPath, assetBase, useTextareaFallback]);

  if (useTextareaFallback) {
    return (
      <textarea
        className="crepe-host ddd-editor-fallback"
        data-testid="ddd-editor"
        defaultValue={initialValue}
        aria-label={docPath}
        onChange={(event) => onChangeRef.current(event.currentTarget.value)}
      />
    );
  }

  return <div className="crepe-host" data-testid="ddd-editor" ref={hostRef} />;
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

export function WorkflowSource() {
  return (
    <section className="card" data-testid="ddd-workflow-source">
      <div className="card-head">
        <h2>Smithers script</h2>
        <span className="pill">{workflowSourcePath}</span>
      </div>
      <pre className="source">{workflowSource}</pre>
    </section>
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
              {cap.status ? <span className={`badge ${statusClass(cap.status)}`}>{statusLabels[cap.status] ?? formatStatus(cap.status)}</span> : null}
            </div>
            <p>{cap.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EndpointBlock({ endpoints, onOpenDoc }: { endpoints?: FeatureEndpoint[]; onOpenDoc?: (href: string) => void }) {
  const eps = endpoints ?? [];
  if (eps.length === 0) return null;
  return (
    <div className="list-block">
      <strong>API endpoints</strong>
      <ul className="endpoint-list">
        {eps.map((ep, index) => (
          <li key={`ep:${index}`}>
            <code className="endpoint">{ep.method} {ep.path}</code>
            {ep.note ? <span className="endpoint-note">({ep.note})</span> : null}
            {ep.doc ? (
              <button type="button" className="doc-link" onClick={() => onOpenDoc?.(ep.doc!)}>docs ↗</button>
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
              <a className="doc-link" href={link.href} target="_blank" rel="noreferrer">{link.label} ↗</a>
            ) : (
              <button type="button" className="doc-link" onClick={() => onOpenDoc?.(link.href)}>{link.label} →</button>
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
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal" role="dialog" aria-modal="true" data-testid="ddd-feature-detail" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">{feature.id}{feature.group ? ` · ${feature.group}` : ""}</span>
            <h2>{feature.title}</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <div className="meta-row">
          <span className={`badge ${statusClass(feature.status)}`}>{statusLabels[feature.status] ?? feature.status}</span>
          <span className="pill">Priority {feature.priority.toUpperCase()}</span>
          <span className="pill">Owner {feature.owner}</span>
          {tier !== "feature" ? <span className="pill">{tier}</span> : null}
        </div>
        {note ? <p className="audit-note">Audit note: {note}</p> : null}
        {media ? <img className="feature-media" src={media} alt="" /> : null}
        {feature.userValue ? <p className="user-value"><strong>What you can do:</strong> {feature.userValue}</p> : null}
        <p>{feature.summary}</p>
        <CapabilityBlock capabilities={feature.capabilities} />
        <EndpointBlock endpoints={feature.endpoints} onOpenDoc={onOpenDoc} />
        <LinkBlock links={feature.links} onOpenDoc={onOpenDoc} />
        <ListBlock title="Test Cases" items={strings(feature.tests)} />
        <ListBlock title="Observability" items={strings(feature.observability)} />
        <ListBlock title="Debugging" items={strings(feature.debug)} />
        <ListBlock title="Architecture" items={strings(feature.architecture)} />
        <ListBlock title="Evidence" items={strings(feature.evidence)} />
        <ListBlock title="Fixes & Diffs" items={[...strings(feature.changes), ...strings(feature.diffHints)]} />
        <ListBlock title="Open Gaps" items={strings(feature.missing)} />
      </section>
    </div>
  );
}

export function OutputCard({ label, row, pending = "waiting" }: { label: string; row: Record<string, unknown> | null; pending?: string }) {
  const summary = asString(row?.summary) || pending;
  const status = asString(row?.status) || (row ? "ready" : "waiting");
  const testId = `ddd-output-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className="card" data-testid={testId}>
      <div className="card-head">
        <h2>{label}</h2>
        <span className={`badge ${statusClass(status)}`}>{formatStatus(status)}</span>
      </div>
      <p>{summary}</p>
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
    " --code-bg:#0a0a0a; --code-text:#f4f4f4; --brand:#6d56d8; --success:#0f8f78; --danger:#e5484d; --warning:#bf7100; --shadow-rgb:10 10 10;" +
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
  ".top { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 18px; border-bottom:1px solid var(--border); background:var(--surface-glass-strong); -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%); }",
  ".title { display:flex; align-items:center; gap:12px; min-width:0; flex:1 1 auto; }",
  "h1 { margin:0; font-size:15px; font-weight:650; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  "h2 { margin:0; font-size:12px; font-weight:650; }",
  "p { margin:0; color:var(--muted); line-height:1.45; }",
  ".eyebrow { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px; }",
  ".pill,.badge { display:inline-flex; align-items:center; min-width:0; max-width:100%; min-height:22px; padding:1px 10px; border:1px solid var(--border); border-radius:999px; font-size:11px; color:var(--text-muted); font-family:ui-monospace,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
  ".pill { border-color:color-mix(in srgb,var(--brand) 22%,transparent); background:color-mix(in srgb,var(--brand) 14%,transparent); color:var(--brand); }",
  ".badge { text-transform:uppercase; font-family:inherit; font-weight:650; }",
  ".badge.ok { color:var(--ok); border-color:color-mix(in srgb,var(--ok),transparent 45%); }",
  ".badge.warn { color:var(--warn); border-color:color-mix(in srgb,var(--warn),transparent 45%); }",
  ".badge.bad { color:var(--bad); border-color:color-mix(in srgb,var(--bad),transparent 45%); }",
  ".actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }",
  ".button { border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:6px; min-height:32px; padding:0 12px; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; gap:6px; }",
  ".button:hover { background:var(--hover); }",
  ".button.primary { border-color:color-mix(in srgb,var(--brand) 40%,transparent); background:color-mix(in srgb,var(--brand) 10%,var(--surface)); color:var(--brand); font-weight:650; }",
  ".button.primary:hover { background:color-mix(in srgb,var(--brand) 16%,var(--surface)); }",
  ".button:focus-visible,.icon-button:focus-visible,.tab:focus-visible,.tree-file:focus-visible,.run-row:focus-visible,.finding:focus-visible,.feature-card.is-clickable:focus-visible,.ticket-row:focus-visible,.doc-link:focus-visible,.tree-dir-name:focus-visible,.tree-section-toggle:focus-visible { outline:none; border-color:color-mix(in srgb,var(--brand) 50%,transparent); box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent); }",
  ".button:disabled { cursor:not-allowed; opacity:.45; }",
  ".icon-button { width:32px; min-height:32px; padding:0; border:1px solid var(--line); background:var(--panel); color:var(--text); border-radius:6px; cursor:pointer; }",
  ".tabbar { min-width:0; display:flex; align-items:center; gap:6px; padding:8px 14px; border-bottom:1px solid var(--border); background:var(--surface); overflow-x:auto; scrollbar-width:thin; }",
  ".tab { flex:0 0 auto; border:1px solid transparent; background:transparent; color:var(--muted); border-radius:6px; min-height:30px; padding:0 12px; cursor:pointer; font-weight:650; display:inline-flex; align-items:center; gap:7px; }",
  ".tab:hover { color:var(--text); }",
  ".tab.is-active { background:color-mix(in srgb,var(--brand) 12%,transparent); border-color:color-mix(in srgb,var(--brand) 30%,transparent); color:var(--brand); }",
  ".tab .count { font-family:ui-monospace,monospace; font-size:10px; color:var(--muted); }",
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
  ".crepe-host { min-height:0; overflow:auto; }",
  ".ddd-editor-fallback { width:100%; height:100%; resize:none; border:0; padding:16px; background:var(--surface); color:var(--text); font:13px/1.5 ui-monospace,monospace; }",
  ".crepe-host .milkdown { height:100%; }",
  ".empty { padding:24px; }",
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
  // audit findings
  ".finding { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; border:1px solid var(--border); border-radius:8px; padding:9px 11px; background:var(--surface); cursor:pointer; text-align:left; color:var(--text); width:100%; transition:border-color .12s ease, background .12s ease; }",
  ".finding:hover { background:var(--hover); border-color:var(--border-strong); }",
  ".finding .fid { font-family:ui-monospace,monospace; font-size:12px; }",
  ".status-counts { display:flex; flex-wrap:wrap; gap:6px; }",
  ".filters { display:grid; grid-template-columns:minmax(180px,1fr) repeat(2,minmax(150px,auto)) auto; gap:8px; align-items:end; min-width:0; }",
  ".filter-field { min-width:0; display:grid; gap:4px; color:var(--text-muted); font-size:11px; font-weight:650; }",
  ".search-input,.select { min-width:0; width:100%; height:32px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); padding:0 10px; font:inherit; }",
  ".search-input:focus,.select:focus { outline:none; border-color:color-mix(in srgb,var(--brand) 45%,transparent); box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 20%,transparent); }",
  ".feature-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:8px; }",
  ".feature-card { min-width:0; border:1px solid var(--border); border-radius:8px; padding:10px; display:grid; gap:7px; background:var(--surface); }",
  ".feature-card.is-clickable { cursor:pointer; text-align:left; color:var(--text); width:100%; transition:border-color .12s ease, background .12s ease; }",
  ".feature-card.is-clickable:hover { background:var(--hover); border-color:color-mix(in srgb,var(--brand) 45%,transparent); }",
  ".feature-card-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".feature-card-head strong { min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; }",
  ".feature-card-foot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }",
  ".tier-section { display:grid; gap:10px; }",
  ".tier-head { display:flex; align-items:center; gap:10px; }",
  ".tier-head h2 { font-size:13px; }",
  ".tier-blurb { margin-top:-4px; }",
  ".group-block { display:grid; gap:7px; }",
  ".group-title { margin:6px 0 2px; font-size:11px; font-weight:650; color:var(--blue); text-transform:uppercase; letter-spacing:.05em; }",
  ".feature-media { width:100%; border-radius:8px; border:1px solid var(--border); }",
  ".slot { min-width:0; border:1px solid var(--border); border-radius:8px; padding:10px; display:grid; gap:7px; background:var(--surface); }",
  ".ticket-row { width:100%; text-align:left; cursor:pointer; color:var(--text); font:inherit; transition:border-color .12s ease, background .12s ease; }",
  ".ticket-row:hover { border-color:var(--border-strong); background:var(--hover); }",
  ".slot-title { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".slot-title strong { min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; }",
  ".meta-row { min-width:0; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }",
  ".meta-row > .pill,.meta-row > .badge { min-width:0; max-width:100%; }",
  ".ticket-path { max-width:min(100%, 52ch); }",
  ".audit-note { color:var(--warn); }",
  ".code { display:block; min-width:0; overflow:auto; white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:11px; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:9px; }",
  ".source { display:block; min-width:0; max-width:100%; max-height:480px; overflow:auto; white-space:pre; font-family:ui-monospace,monospace; font-size:11px; line-height:1.5; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:12px; }",
  ".list-block { display:grid; gap:6px; }",
  ".list-block strong { color:var(--text); font-size:12px; }",
  "ul { margin:0; padding-left:18px; color:var(--muted); line-height:1.45; }",
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
  ".run-row { min-width:0; border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--surface); cursor:pointer; display:grid; gap:4px; text-align:left; color:var(--text); width:100%; transition:border-color .12s ease, background .12s ease; }",
  ".run-row:hover { background:var(--hover); }",
  ".run-row.is-active { border-color:color-mix(in srgb,var(--brand) 40%,transparent); background:color-mix(in srgb,var(--brand) 8%,var(--surface)); }",
  ".run-row .rid { font-family:ui-monospace,monospace; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  ".livelog { max-height:340px; overflow:auto; background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:8px; font-family:ui-monospace,monospace; font-size:11px; line-height:1.55; }",
  ".livelog-line { display:flex; gap:8px; padding:1px 0; white-space:pre-wrap; word-break:break-word; }",
  ".livelog-event { color:var(--blue); flex:none; }",
  ".livelog-node { color:var(--warn); flex:none; }",
  ".livelog-detail { color:var(--code-text); min-width:0; }",
  ".chat { display:grid; gap:8px; }",
  ".chat-line { min-width:0; border:1px solid var(--border); border-left:3px solid var(--border-strong); border-radius:8px; padding:8px 10px; background:var(--surface); }",
  ".chat-line .who { color:var(--blue); font-family:ui-monospace,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.05em; }",
  ".chat-line pre { margin:4px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font-family:ui-monospace,monospace; font-size:11px; color:var(--text); }",
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
  ".nodetree li { margin:4px 0; }",
  ".nodetree .node-row { display:flex; align-items:center; gap:8px; }",
  ".nodetree .node-name { color:var(--text); }",
  ".ticket-detail-body { display:grid; gap:10px; }",
  ".ticket-section { display:grid; gap:6px; }",
  ".ticket-section h3 { margin:0; font-size:12px; }",
  ".ticket-meta-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; }",
  ".ticket-meta { min-width:0; border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--hover-subtle); display:grid; gap:3px; }",
  ".ticket-meta span { color:var(--text-muted); font-size:10px; text-transform:uppercase; letter-spacing:.06em; font-weight:650; }",
  ".ticket-meta strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; color:var(--text); }",
  ".modal-backdrop { position:fixed; inset:0; background:rgb(var(--shadow-rgb) / 0.5); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); display:grid; place-items:center; padding:20px; z-index:60; overflow:hidden; }",
  ".modal { width:min(760px,calc(100vw - 40px)); max-height:86vh; overflow:auto; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:18px; display:grid; gap:13px; box-shadow:0 24px 80px rgb(var(--shadow-rgb) / 0.2); }",
  ".modal-head { min-width:0; display:flex; align-items:start; justify-content:space-between; gap:12px; }",
  ".modal-head > div { min-width:0; }",
  ".modal-head h2 { overflow-wrap:anywhere; }",
  // docs tree sections: product docs first-class, technical docs behind a menu
  ".badge.muted { color:var(--text-muted); }",
  ".tree-section { padding:6px 8px 2px; display:grid; gap:2px; }",
  ".doc-tree-search { display:grid; gap:4px; padding:10px 10px 6px; color:var(--text-muted); font-size:11px; font-weight:650; }",
  ".tree-section .tree { padding:2px 0; }",
  ".tree-section-title { display:flex; align-items:center; gap:6px; color:var(--text-muted); font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.06em; padding:4px 6px; }",
  ".tree-section-toggle { cursor:pointer; border-radius:6px; list-style:revert; }",
  ".tree-section-toggle:hover { color:var(--text); background:var(--hover-subtle); }",
  ".tree-section-title .count { font-family:ui-monospace,monospace; font-size:10px; }",
  ".tree-empty { padding:4px 6px; font-size:11px; }",
  ".agent-docs-callout { margin:4px 6px 6px; padding:8px 10px; font-size:11px; line-height:1.5; color:var(--text-muted); border:1px solid color-mix(in srgb,var(--brand) 30%,transparent); border-radius:8px; background:color-mix(in srgb,var(--brand) 7%,var(--surface)); }",
  ".technical-doc-view { max-height:none; height:100%; border:0; border-radius:0; }",
  // start pane (the way in: create a new app / generate docs from code)
  ".start.scroll { max-width:960px; margin:0 auto; width:100%; }",
  ".start-intro p { max-width:64ch; }",
  ".start-textarea { min-height:88px; height:auto; padding:8px 10px; resize:vertical; font:inherit; line-height:1.45; }",
  ".start-actions { display:flex; align-items:center; gap:8px; }",
  ".start-status { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:12px; }",
  // guided tutorial overlay
  ".tutorial-backdrop { position:fixed; inset:0; background:rgb(var(--shadow-rgb) / 0.5); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); display:grid; place-items:center; padding:20px; z-index:70; }",
  ".tutorial-card { width:min(620px,calc(100vw - 40px)); max-height:86vh; overflow:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:20px; display:grid; gap:12px; box-shadow:0 24px 80px rgb(var(--shadow-rgb) / 0.2); }",
  ".tutorial-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".tutorial-title { font-size:16px; }",
  ".tutorial-body { color:var(--text); line-height:1.55; }",
  ".tutorial-sample { max-height:220px; }",
  ".tutorial-hint { font-size:12px; color:var(--text-muted); border-left:3px solid color-mix(in srgb,var(--brand) 45%,transparent); padding-left:10px; }",
  ".tutorial-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".tutorial-steps-nav { display:flex; align-items:center; gap:8px; }",
  "@media (max-width: 980px) { .specs,.live { grid-template-columns:1fr; } .specs-tree,.runlist { border-right:0; border-bottom:1px solid var(--border); max-height:220px; } }",
  "@media (max-width: 620px) { .shell { height:100dvh; } .top { align-items:flex-start; flex-wrap:wrap; padding:10px 12px; gap:10px; } .title { flex-wrap:wrap; gap:8px; } h1 { width:100%; } .actions { width:100%; justify-content:flex-start; } .tabbar { padding:8px 10px; } .scroll { padding:10px; } .card { padding:12px; } .card-head { align-items:flex-start; flex-wrap:wrap; } .stats,.grid2 { grid-template-columns:1fr; } .feature-grid,.cap-grid { grid-template-columns:minmax(0,1fr); } .filters { grid-template-columns:1fr; } .editor-bar { align-items:flex-start; flex-wrap:wrap; } .editor-title { width:100%; } .dispatch-actions { width:100%; display:grid; grid-template-columns:1fr; } .button { width:100%; } .specs-tree,.runlist { max-height:190px; } .slot-title { align-items:flex-start; } .modal-backdrop { padding:10px; place-items:start center; } .modal { width:calc(100vw - 20px); max-height:calc(100dvh - 20px); padding:14px; } }",
].join("\n");

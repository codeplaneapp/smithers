import type { GatewayEventFrame } from "@smthrs/gateway-client";
import type { ToolCallState } from "@smthrs/ui";

/**
 * Pure transcript model behind {@link NodeChatStream}: fold node-scoped event
 * frames down to one node's live agent conversation.
 *
 * The engine emits two chat-bearing event types per agent node:
 * - `NodeOutput` — raw stdout/stderr text chunks (`{ nodeId, text, stream }`)
 * - `AgentEvent` — structured agent actions (`{ nodeId, engine, event }`) where
 *   `event` is `{ type: "action", action: { kind, id, title, detail }, phase }`
 *   or `{ type: "completed", answer }`
 * plus node lifecycle frames (`NodeStarted`/`NodeFinished`/...) that carry the
 * same `nodeId`. This module is UI-free so the fold is unit-testable.
 */

export type NodeChatToolCall = {
  id: string;
  name: string;
  state: ToolCallState;
  argsText?: string;
  resultText?: string;
};

export type NodeChatFile = {
  path: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  unifiedDiff?: string;
};

export type NodeChatItem =
  | { kind: "marker"; key: string; label: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "stderr"; key: string; text: string }
  | { kind: "reasoning"; key: string; text: string }
  | { kind: "tool"; key: string; call: NodeChatToolCall }
  | { kind: "note"; key: string; label: string }
  | { kind: "file_change"; key: string; label: string; files: NodeChatFile[] };

export type NodeChatTranscript = {
  items: NodeChatItem[];
  /** Node lifecycle status derived from frames (undefined until a lifecycle frame is seen). */
  status: string | undefined;
  /** The agent engine reported by the first AgentEvent (e.g. "claude", "codex"). */
  engine: string | undefined;
  /** True while the node is running (chat is still streaming). */
  streaming: boolean;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parsePayload(value: unknown): UnknownRecord | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const LIFECYCLE_STATUS: Record<string, string> = {
  NodePending: "queued",
  NodeStarted: "running",
  NodeRetrying: "running",
  NodeFinished: "ok",
  NodeFailed: "failed",
  NodeStalled: "failed",
  NodeCancelled: "cancelled",
  NodeSkipped: "cancelled",
  NodeWaitingApproval: "waiting",
  NodeWaitingTimer: "waiting",
};

const FILE_CHANGE_KIND: Record<string, NodeChatFile["kind"]> = {
  created: "created",
  add: "created",
  modified: "modified",
  update: "modified",
  deleted: "deleted",
  delete: "deleted",
  renamed: "renamed",
  rename: "renamed",
};

/**
 * Prefer the normalized `detail.fileChanges` (`AgentFileChange[]`, richer
 * kind/diff data — see `packages/agents` `parseFileChanges`) when a harness
 * adapter attached it; fall back to the legacy `detail.changes`/`detail.file`
 * scan for adapters that haven't been migrated.
 */
function parseFileChangeFiles(detail: UnknownRecord): NodeChatFile[] {
  const normalized = detail.fileChanges;
  if (Array.isArray(normalized) && normalized.length) {
    const files = normalized
      .map((entry): NodeChatFile | undefined => {
        if (!isRecord(entry)) return undefined;
        const path = str(entry.path);
        if (!path) return undefined;
        const kind = FILE_CHANGE_KIND[str(entry.kind) ?? ""] ?? "modified";
        const oldPath = str(entry.oldPath);
        const unifiedDiff = str(entry.unifiedDiff);
        return { path, kind, ...(oldPath ? { oldPath } : {}), ...(unifiedDiff ? { unifiedDiff } : {}) };
      })
      .filter((file): file is NodeChatFile => Boolean(file));
    if (files.length) return files;
  }
  const changes = detail.changes;
  if (Array.isArray(changes) && changes.length) {
    return changes
      .map((change): NodeChatFile | undefined => {
        if (!isRecord(change)) return undefined;
        const path = str(change.file) ?? str(change.path);
        if (!path) return undefined;
        const kind = FILE_CHANGE_KIND[str(change.kind) ?? ""] ?? "modified";
        return { path, kind };
      })
      .filter((file): file is NodeChatFile => Boolean(file));
  }
  return [];
}

function describeFileChange(files: NodeChatFile[], fallback: string): string {
  if (files.length) {
    const head = files
      .slice(0, 3)
      .map((f) => f.path)
      .join(", ");
    return `Edited ${head}${files.length > 3 ? ` +${files.length - 3} more` : ""}`;
  }
  return fallback || "Files changed";
}

function formatArgs(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 1);
  } catch {
    return undefined;
  }
}

/**
 * Fold run event frames into one node's chat transcript. Consecutive text
 * chunks coalesce into single messages, tool actions merge their
 * started/completed phases by action id, and attempt/iteration changes insert
 * separator markers. `maxItems` (default 200) keeps the tail.
 */
export function buildNodeChatTranscript(
  frames: ReadonlyArray<Pick<GatewayEventFrame, "event" | "payload" | "seq">>,
  nodeId: string,
  options: { maxItems?: number } = {},
): NodeChatTranscript {
  const maxItems = options.maxItems ?? 200;
  const items: NodeChatItem[] = [];
  const toolIndex = new Map<string, number>();
  const fileChangeIndex = new Map<string, number>();
  const pendingFileChanges = new Map<string, { files: NodeChatFile[]; label: string }>();
  let status: string | undefined;
  let engine: string | undefined;
  let attemptKey: string | undefined;
  let sawContent = false;

  const markAttempt = (payload: UnknownRecord, seq: number) => {
    const iteration = typeof payload.iteration === "number" ? payload.iteration : 0;
    const attempt = typeof payload.attempt === "number" ? payload.attempt : 1;
    const key = `${iteration}:${attempt}`;
    if (attemptKey !== undefined && attemptKey !== key && sawContent) {
      items.push({
        kind: "marker",
        key: `marker:${seq}`,
        label: `attempt ${attempt}${iteration > 0 ? ` · iteration ${iteration}` : ""}`,
      });
      toolIndex.clear();
      fileChangeIndex.clear();
      pendingFileChanges.clear();
    }
    attemptKey = key;
  };

  const appendText = (kind: "text" | "stderr" | "reasoning", seq: number, text: string) => {
    const last = items[items.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      items.push({ kind, key: `${kind}:${seq}`, text });
    }
    sawContent = true;
  };

  for (const frame of frames) {
    const payload = parsePayload(frame.payload);
    if (!payload || payload.nodeId !== nodeId) continue;

    const lifecycle = LIFECYCLE_STATUS[frame.event];
    if (lifecycle !== undefined) {
      status = lifecycle;
      if (frame.event === "NodeRetrying" && sawContent) {
        items.push({ kind: "marker", key: `retry:${frame.seq}`, label: "retrying" });
      }
      continue;
    }

    if (frame.event === "NodeOutput") {
      const text = str(payload.text);
      if (!text) continue;
      markAttempt(payload, frame.seq);
      appendText(payload.stream === "stderr" ? "stderr" : "text", frame.seq, text);
      continue;
    }

    if (frame.event !== "AgentEvent") continue;
    engine = engine ?? str(payload.engine);
    const agentEvent = isRecord(payload.event) ? payload.event : undefined;
    if (!agentEvent) continue;
    markAttempt(payload, frame.seq);

    if (agentEvent.type === "completed") {
      const answer = str(agentEvent.answer);
      // CLI agents usually stream the answer over stdout too; only append when
      // the transcript doesn't already end with it.
      const last = items[items.length - 1];
      if (answer && !(last?.kind === "text" && last.text.trimEnd().endsWith(answer.trimEnd()))) {
        appendText("text", frame.seq, answer);
      }
      continue;
    }

    if (agentEvent.type !== "action") continue;
    const action = isRecord(agentEvent.action) ? agentEvent.action : {};
    const detail = isRecord(action.detail) ? action.detail : {};
    const kind = str(action.kind) ?? "unknown";
    const phase = str(agentEvent.phase);
    const message = str(agentEvent.message) ?? "";
    const title = str(action.title) ?? kind;

    if (kind === "tool" || kind === "command") {
      const actionId = str(action.id) ?? `${title}:${frame.seq}`;
      const existing = toolIndex.get(actionId);
      if (existing === undefined) {
        toolIndex.set(actionId, items.length);
        items.push({
          kind: "tool",
          key: `tool:${actionId}:${frame.seq}`,
          call: {
            id: actionId,
            name: title,
            state: phase === "completed" ? "output-available" : "running",
            argsText: formatArgs(detail.input),
            resultText: phase === "completed" ? (str(detail.output) ?? str(message)) : undefined,
          },
        });
      } else if (phase === "completed") {
        const item = items[existing];
        if (item?.kind === "tool") {
          item.call = {
            ...item.call,
            state: "output-available",
            resultText: str(detail.output) ?? str(message) ?? item.call.resultText,
          };
        }
      }
      sawContent = true;
    } else if (kind === "reasoning" || (kind === "note" && agentEvent.entryType === "thought")) {
      if (message) appendText("reasoning", frame.seq, message);
    } else if (kind === "file_change") {
      const actionId = str(action.id) ?? `${title}:${frame.seq}`;
      const files = parseFileChangeFiles(detail);
      if (phase !== undefined && phase !== "completed") {
        // A started edit is merely proposed. Do not show it until the tool
        // result confirms success; denied/failed edits must not look applied.
        if (files.length) pendingFileChanges.set(actionId, { files, label: describeFileChange(files, title) });
      } else {
        if (agentEvent.ok === false) {
          pendingFileChanges.delete(actionId);
          continue;
        }
        const pending = pendingFileChanges.get(actionId);
        const completedFiles = files.length ? files : (pending?.files ?? []);
        const label = describeFileChange(completedFiles, pending?.label ?? title);
        pendingFileChanges.delete(actionId);
        const existing = fileChangeIndex.get(actionId);
        if (existing === undefined) {
          fileChangeIndex.set(actionId, items.length);
          items.push({ kind: "file_change", key: `filechange:${actionId}:${frame.seq}`, label, files: completedFiles });
        } else {
          const item = items[existing];
          if (item?.kind === "file_change") {
            item.label = label;
            item.files = completedFiles.length ? completedFiles : item.files;
          }
        }
        sawContent = true;
      }
    } else if (kind === "web_search") {
      items.push({
        kind: "note",
        key: `note:${frame.seq}`,
        label: `Searched: ${title !== "web_search" ? title : message || "the web"}`,
      });
      sawContent = true;
    }
    // Other kinds (turn, todo_list, generic notes) stay off the transcript.
  }

  const trimmed = items.length > maxItems ? items.slice(items.length - maxItems) : items;
  if (trimmed.length < items.length) {
    trimmed.unshift({ kind: "marker", key: "marker:truncated", label: "earlier output truncated" });
  }
  return { items: trimmed, status, engine, streaming: status === "running" };
}

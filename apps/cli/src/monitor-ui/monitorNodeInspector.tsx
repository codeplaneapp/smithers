/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGatewayNodeOutput,
  useGatewayRpc,
  useGatewayRun,
} from "smithers-orchestrator/gateway-react";
import { Button } from "smithers-orchestrator/ui";
import { processPatch, type CodeViewItem } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import type { IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import {
  asArray,
  asNumber,
  asString,
  canRetryTask,
  diffPatchesOf,
  diffSummaryOf,
  formatDiffSummary,
  formatEventLine,
  formatOutputValue,
  hijackActionFor,
  hijackCandidateForNode,
  hijackCandidatesOf,
  isRecord,
  labelForStatus,
  looksLikeUnifiedDiff,
  nodeErrorOf,
  nodeSummaryEligible,
  ptyHijackUrl,
  rowOf,
  splitPatchText,
  sumDiffSummaries,
  toneForStatus,
  treeNodeKey,
  type HijackCandidate,
  type Tone,
} from "./monitorModel.ts";
import { Chip, ToneDot } from "./monitorShell.tsx";
import type { TreeNode } from "./monitorExecution.tsx";
import { NodeScoreChips, type RunScores } from "./monitorScores.tsx";
import { StatusTag } from "./monitorShared.tsx";

// ---------------------------------------------------------------------------
// Node inspector.
// ---------------------------------------------------------------------------

/**
 * Make one transcript line scannable: drop completed-command echoes (the next
 * started line implies completion), strip the agent-name and shell-wrapper
 * noise from commands, and classify lines so commands, chat text, and
 * lifecycle metadata read differently.
 */
function formatLiveTranscriptLine(
  eventName: string,
  detail: string,
): { text: string; kind: "cmd" | "text" | "meta" } | null {
  let text = detail.replace(/^[a-z0-9_-]+ · /i, "");
  if (/^completed command · /.test(text)) return null;
  if (/^started command · /.test(text)) {
    text = text
      .replace(/^started command · /, "")
      .replace(/^\/bin\/(?:zsh|bash|sh) -l?c\s+/, "")
      .replace(/^["']|["']$/g, "");
    return { text: `$ ${text.slice(0, 220)}`, kind: "cmd" };
  }
  if (/^(started|completed)( turn| ·|$)/.test(text) || /^Node(Started|Finished|Failed|Retrying)/.test(eventName)) {
    return { text: text.slice(0, 160), kind: "meta" };
  }
  return { text: text.slice(0, 400), kind: "text" };
}

/**
 * AgentSessionEvent rows wrap the agent's own transcript stream (the codex /
 * claude CLI JSON items). They are by far the densest signal a live node
 * emits, so surface the useful items — chat text, commands, tool output —
 * and drop protocol noise. Without these the live panel sat on "No output"
 * for minutes while the agent was visibly working.
 */
function formatSessionTranscriptLine(
  payload: unknown,
): { text: string; kind: "cmd" | "text" | "meta" } | null {
  if (!isRecord(payload)) return null;
  const transcript = isRecord(payload.transcript) ? payload.transcript : undefined;
  const raw = transcript && isRecord(transcript.raw) ? transcript.raw : undefined;
  const item = raw && isRecord(raw.payload) ? raw.payload : undefined;
  if (!item) return null;
  const textOf = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((part) =>
          typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : "",
        )
        .filter(Boolean)
        .join(" ");
    }
    if (isRecord(value) && typeof value.text === "string") return value.text;
    return "";
  };
  const itemType = String(item.type ?? "");
  if (itemType === "message") {
    const text = textOf(item.content).trim();
    return text ? { text: text.slice(0, 400), kind: "text" } : null;
  }
  if (itemType === "reasoning") return null;
  if (itemType === "local_shell_call" || itemType === "shell_call") {
    const action = isRecord(item.action) ? item.action : undefined;
    const command = action ? textOf(action.command).trim() : "";
    return command ? { text: `$ ${command.slice(0, 220)}`, kind: "cmd" } : null;
  }
  if (itemType === "function_call" || itemType === "custom_tool_call") {
    const name = typeof item.name === "string" ? item.name : "tool";
    const args = typeof item.arguments === "string" ? item.arguments : typeof item.input === "string" ? item.input : "";
    // codex shell calls arrive as a function_call whose arguments hold the command.
    if (args.includes('"command"')) {
      try {
        const parsed: unknown = JSON.parse(args);
        const command = isRecord(parsed) ? textOf(parsed.command).trim() : "";
        if (command) return { text: `$ ${command.slice(0, 220)}`, kind: "cmd" };
      } catch {
        // fall through to the generic tool line
      }
    }
    return { text: `⚙ ${name}${args ? ` ${args.slice(0, 160)}` : ""}`, kind: "cmd" };
  }
  if (itemType.endsWith("_output")) {
    const text = textOf(item.output).trim();
    return text ? { text: text.slice(0, 300), kind: "meta" } : null;
  }
  return null;
}

/**
 * Live transcript for an in-flight node. The shared run-event ring drowns any
 * single node on a busy run (16 streaming agents rotate 500 events in
 * seconds), so this polls the gateway's per-node event filter incrementally:
 * the first poll returns a bounded tail of this node's history, and each
 * subsequent poll reads only past the last seen seq.
 */
function NodeLiveOutput({ runId, nodeId, live }: { runId: string; nodeId: string; live: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [lines, setLines] = useState<Array<{ seq: number; text: string; kind: "cmd" | "text" | "meta" }>>([]);
  const [failed, setFailed] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => {
    setLines([]);
    setFailed(false);
    setLoadedOnce(false);
    let cancelled = false;
    // An absent cursor asks the node-filtered events route for its newest
    // bounded window. Once seeded, every poll advances forward from the last
    // observed sequence.
    let afterSeq: number | undefined;
    let inFlight = false;
    const poll = async () => {
      // The first poll scans history and can outlive the interval; overlapping
      // polls would both start from the same cursor and append the tail twice.
      if (inFlight) return;
      inFlight = true;
      try {
        const search = new URLSearchParams({ nodeId, limit: "120" });
        if (afterSeq !== undefined) search.set("afterSeq", String(afterSeq));
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/events?${search}`);
        if (!response.ok) throw new Error(`events ${response.status}`);
        const body = (await response.json()) as { data?: unknown[] };
        const rows = Array.isArray(body.data) ? body.data : [];
        const fresh: Array<{ seq: number; text: string; kind: "cmd" | "text" | "meta" }> = [];
        for (const raw of rows) {
          if (!isRecord(raw)) continue;
          const name = String(raw.event ?? "");
          const seq = asNumber(raw.seq) ?? 0;
          if (afterSeq === undefined || seq > afterSeq) afterSeq = seq;
          if (name === "AgentSessionEvent") {
            const formatted = formatSessionTranscriptLine(raw.payload);
            if (formatted) fresh.push({ seq, ...formatted });
            continue;
          }
          if (!/AgentEvent|AgentTraceEvent|NodeOutput|ToolCall|task\.output|agent\.|NodeStarted|NodeFinished|NodeFailed|NodeRetrying/i.test(name)) continue;
          const line = formatEventLine({ event: name, seq, payload: raw.payload });
          const text = line.detail.startsWith(`${nodeId} · `) ? line.detail.slice(nodeId.length + 3) : line.detail;
          const formatted = formatLiveTranscriptLine(name, text || name);
          if (!formatted) continue;
          fresh.push({ seq, ...formatted });
        }
        if (!cancelled && fresh.length) {
          setLines((previous) => {
            const lastSeq = previous.length ? previous[previous.length - 1].seq : -1;
            const appended = fresh.filter((line) => line.seq > lastSeq);
            return appended.length ? [...previous, ...appended].slice(-120) : previous;
          });
        }
        if (!cancelled) {
          setFailed(false);
          setLoadedOnce(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    // Terminal nodes get a one-shot transcript; only live nodes keep polling.
    // Per-node reads are a single indexed SQL pass, so a tight cadence is
    // cheap and the transcript reads as streaming.
    const timer = live ? setInterval(() => void poll(), 1_200) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, nodeId, live]);
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  if (lines.length === 0) {
    return (
      <div className="mon-empty mon-dim">
        {failed
          ? "Could not load this node's events."
          : !loadedOnce
            ? <span className="mon-live-pending"><span className="mon-dot mon-dot-pulse" aria-hidden /> loading transcript…</span>
            : "No output from this node yet — its events land here as they arrive."}
      </div>
    );
  }
  return (
    <div className="mon-output mon-live-output" ref={containerRef} data-testid="monitor-live-output">
      {lines.map((line) => (
        <div key={line.seq} className={`mon-live-line mon-live-${line.kind}`}>
          {line.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff rendering. Unified-diff strings (node diffs from the gateway's
// getNodeDiff, and output fields that carry a raw patch) render through
// @pierre/diffs — syntax-colored added/removed lines — behind a
// collapsed-by-default summary ("N files, +X/−Y") so a big patch never
// swamps the inspector.
// ---------------------------------------------------------------------------

/**
 * A patch as a proper diff view. Parsing runs per `diff --git` chunk: real
 * bundles mix cleanly parseable files with ones @pierre/diffs' strict hunk
 * parser rejects (binary patches, odd counts), so the parseable files render
 * syntax-colored and the rejects fall back to raw text below — one bad file
 * never blanks the whole diff.
 */
function PatchDiffView({ patch }: { patch: string }) {
  const { files, rejected } = useMemo(() => {
    const parsedFiles: ReturnType<typeof processPatch>["files"] = [];
    const rawChunks: string[] = [];
    for (const [index, chunk] of splitPatchText(patch).entries()) {
      try {
        parsedFiles.push(...processPatch(chunk, `smithers-monitor-${index}`, true).files);
      } catch {
        rawChunks.push(chunk);
      }
    }
    return { files: parsedFiles, rejected: rawChunks };
  }, [patch]);
  const dark = isDarkTheme();
  const items: CodeViewItem[] = files.map((file, index) => ({
    id: `${file.name ?? index}`,
    type: "diff",
    fileDiff: file,
  }));
  return (
    <div className="mon-diff-view" data-testid="monitor-diff-view">
      {items.length > 0 ? (
        <CodeView
          disableWorkerPool
          items={items}
          options={{
            collapsedContextThreshold: 12,
            diffIndicators: "bars",
            diffStyle: "unified",
            hunkSeparators: "metadata",
            overflow: "wrap",
            theme: dark ? "github-dark" : "github-light",
            themeType: dark ? "dark" : "light",
          }}
        />
      ) : null}
      {rejected.length > 0 ? (
        <>
          {items.length > 0 ? (
            <div className="mon-dim mon-diff-raw-note">
              {rejected.length} {rejected.length === 1 ? "file" : "files"} shown as raw patch text (not parseable as a
              clean unified diff):
            </div>
          ) : null}
          <pre className="mon-output mon-diff-raw">{rejected.join("\n")}</pre>
        </>
      ) : null}
    </div>
  );
}

/**
 * Collapsed-by-default diff block: the summary line carries the honest counts
 * ("N files, +X/−Y"); the diff view only mounts on first expand, so shiki
 * never tokenizes patches nobody opened.
 */
function CollapsedDiff({
  patch,
  summaryText,
  label,
  testId,
}: {
  patch: string;
  summaryText?: string;
  label?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => diffSummaryOf(patch), [patch]);
  return (
    <details
      className="mon-diff"
      data-testid={testId ?? "monitor-diff"}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="mon-diff-summary">
        <span className="mon-diff-caret" aria-hidden>
          ▸
        </span>
        {label ? <span className="mon-diff-label mon-mono">{label}</span> : null}
        <span className="mon-diff-stat mon-mono">{summaryText ?? formatDiffSummary(summary)}</span>
      </summary>
      {open ? <PatchDiffView patch={patch} /> : null}
    </details>
  );
}

/**
 * The node's recorded VCS diff (what this task's attempt changed on disk),
 * fetched from the gateway's getNodeDiff route. Only settled nodes have one
 * (the route refuses in-flight attempts); nodes without a recorded diff — the
 * common case for compute tasks — simply show nothing.
 */
function NodeDiffSection({
  runId,
  nodeId,
  iteration,
  enabled,
}: {
  runId: string;
  nodeId: string;
  iteration: number;
  enabled: boolean;
}) {
  const [patches, setPatches] = useState<Array<{ path: string; diff: string }>>([]);
  useEffect(() => {
    setPatches([]);
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const search = new URLSearchParams({ iteration: String(iteration) });
        const response = await fetch(
          `/v1/api/nodes/${encodeURIComponent(runId)}/${encodeURIComponent(nodeId)}/diff?${search}`,
        );
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!cancelled) setPatches(diffPatchesOf(body));
      } catch {
        // No recorded diff (or a VCS error) just hides the section.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [runId, nodeId, iteration, enabled]);
  if (patches.length === 0) return null;
  const combined = patches.map((patch) => patch.diff).join("\n");
  const rollup = sumDiffSummaries(patches.map((patch) => diffSummaryOf(patch.diff)));
  return (
    <>
      <h3 className="mon-kicker">Diff</h3>
      <CollapsedDiff
        patch={combined}
        summaryText={formatDiffSummary({ ...rollup, files: patches.length })}
        testId="monitor-node-diff"
      />
    </>
  );
}

/** Envelope bookkeeping already shown in the inspector's meta grid. */
const OUTPUT_RESERVED_KEYS = new Set(["runId", "nodeId", "iteration"]);

/**
 * A node's structured output, one labeled block per field instead of one raw
 * JSON dump. Strings render verbatim (multiline intact), scalars sit inline
 * next to their key, and nested values pretty-print on their own.
 */
function OutputFields({ row }: { row: unknown }) {
  if (!isRecord(row)) {
    return <pre className="mon-output">{formatOutputValue(row)}</pre>;
  }
  const entries = Object.entries(row);
  const fields = entries.filter(([key]) => !OUTPUT_RESERVED_KEYS.has(key));
  const shown = fields.length > 0 ? fields : entries;
  if (shown.length === 0) {
    return <pre className="mon-output">{formatOutputValue(row)}</pre>;
  }
  return (
    <div className="mon-output mon-output-fields" data-testid="monitor-output-fields">
      {shown.map(([key, value]) => {
        const scalar =
          value === null || typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : typeof value === "string" && value.length <= 80 && !value.includes("\n")
              ? value
              : undefined;
        return (
          <div className="mon-output-field" key={key}>
            <span className="mon-output-key mon-mono">{key}</span>
            {scalar !== undefined ? (
              <span className="mon-output-scalar mon-mono">{scalar}</span>
            ) : looksLikeUnifiedDiff(value) ? (
              <CollapsedDiff patch={value as string} testId="monitor-output-diff" />
            ) : (
              <pre className="mon-output-val">{formatOutputValue(value)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TERMINAL_NODE_TONES = new Set(["ok", "failed", "cancelled"]);

/**
 * The AI "what happened" recap at the top of the inspector. The gateway's
 * whatHappened RPC narrates with the host-configured cheap agent and falls
 * back to a deterministic fact summary, so this renders something for every
 * settled node; errors just hide the panel.
 */
function NodeWhatHappened({ runId, nodeId, iteration, status }: { runId: string; nodeId: string; iteration: number; status?: string }) {
  const enabled = nodeSummaryEligible(status);
  const summary = useGatewayRpc("whatHappened", { runId, nodeId, iteration }, { enabled });
  if (!enabled || summary.error) return null;
  return (
    <div className="mon-what" data-testid="monitor-what-happened">
      <h3 className="mon-kicker">What happened</h3>
      {summary.data ? (
        <>
          <div className="mon-what-summary">{summary.data.summary}</div>
          <div className="mon-what-source mon-dim">
            {summary.data.source === "agent"
              ? `narrated by ${summary.data.agentId ?? "agent"}`
              : "recorded facts (no narrator agent)"}
          </div>
        </>
      ) : (
        <div className="mon-empty mon-dim">Summarizing what happened…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PTY hijack terminal. An embedded xterm.js terminal (the same stack the
// smithers cloud UI uses for its workspace terminals — ghostty stays a native
// app; the web falls back to xterm) attached to the gateway's /v1/pty/hijack
// websocket, which runs `smithers hijack <runId> --target <nodeId>` in a real
// PTY. Transport mirrors the cloud terminal client: binary frames are raw PTY
// bytes both ways; text frames are JSON control messages (`resize` up,
// `exit`/`error` down).
// ---------------------------------------------------------------------------

type HijackStatus = "connecting" | "connected" | "exited" | "closed" | "error";

function isDarkTheme(): boolean {
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Poll the gateway's per-node hijack candidates for a run (5s while live). */
function useHijackCandidates(runId: string, live: boolean): HijackCandidate[] {
  const [candidates, setCandidates] = useState<HijackCandidate[]>([]);
  useEffect(() => {
    setCandidates([]);
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/hijack-candidates`);
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!cancelled) setCandidates(hijackCandidatesOf(body));
      } catch {
        // Transient fetch failures just keep the previous candidate view.
      }
    };
    void load();
    const timer = live ? setInterval(() => void load(), 5_000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, live]);
  return candidates;
}

function HijackTerminal({
  runId,
  nodeId,
  dark,
  onStatus,
}: {
  runId: string;
  nodeId: string;
  dark: boolean;
  onStatus: (status: HijackStatus) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    const ac = new AbortController();
    // Every resource is hoisted to effect scope and assigned as created, so
    // the cleanup always disposes whatever exists — including a teardown while
    // connect() is still awaiting the dynamic import (mirrors the cloud UI's
    // TerminalSession discipline).
    let term: XTerminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let dataDisposable: IDisposable | null = null;
    let ws: WebSocket | null = null;
    const encoder = new TextEncoder();

    async function connect() {
      onStatus("connecting");
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (ac.signal.aborted || !host) return;
      // The mount div persists across effect re-runs — never stack a second
      // terminal into it.
      host.replaceChildren();
      const terminalStyle = getComputedStyle(host);
      term = new Terminal({
        theme: {
          background: terminalStyle.backgroundColor,
          foreground: terminalStyle.color,
          cursor: terminalStyle.borderTopColor,
          selectionBackground: terminalStyle.outlineColor,
        },
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        cursorBlink: true,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      fitAddon.fit();
      const boundTerm = term;
      const socket = new WebSocket(ptyHijackUrl(location.origin, runId, nodeId, { cols: boundTerm.cols, rows: boundTerm.rows }));
      ws = socket;
      socket.binaryType = "arraybuffer";
      const sendResize = () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "resize", cols: boundTerm.cols, rows: boundTerm.rows }));
      };
      socket.onopen = () => {
        onStatus("connected");
        sendResize();
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          // JSON control frames; unknown types are ignored for forward compat.
          try {
            const message = JSON.parse(event.data) as { type?: unknown; code?: unknown; message?: unknown };
            if (message.type === "exit") {
              onStatus("exited");
              boundTerm.writeln(`\r\n\x1b[2m[session ended${typeof message.code === "number" ? ` · exit ${message.code}` : ""}]\x1b[0m`);
            } else if (message.type === "error") {
              onStatus("error");
              boundTerm.writeln(`\r\n\x1b[1;31m${String(message.message ?? "PTY error")}\x1b[0m`);
            }
          } catch {
            // Not JSON: drop, PTY bytes only travel on binary frames.
          }
          return;
        }
        boundTerm.write(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onerror = () => {
        onStatus("error");
        boundTerm.writeln("\r\n\x1b[1;31mTerminal socket error — the connection to the gateway failed.\x1b[0m");
      };
      socket.onclose = (event) => {
        if (event.code !== 1000) onStatus("closed");
      };
      dataDisposable = boundTerm.onData((data) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const bytes = encoder.encode(data);
        socket.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      });
      resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              fitAddon.fit();
              sendResize();
            })
          : null;
      resizeObserver?.observe(host);
      boundTerm.focus();
    }

    void connect().catch(() => {
      if (!ac.signal.aborted) onStatus("error");
    });

    return () => {
      ac.abort();
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      try {
        ws?.close(1000, "terminal closed");
      } catch {
        // Closing a CONNECTING socket can throw in some environments.
      }
      term?.dispose();
    };
  }, [runId, nodeId, dark]);
  return (
    <div className="mon-hijack-terminal" ref={mountRef} data-testid="monitor-hijack-terminal" />
  );
}

const HIJACK_STATUS_TONES: Record<HijackStatus, Tone> = {
  connecting: "waiting",
  connected: "ok",
  exited: "idle",
  closed: "idle",
  error: "failed",
};

function HijackModal({
  runId,
  nodeId,
  label,
  engine,
  onClose,
}: {
  runId: string;
  nodeId: string;
  label: string;
  engine: string;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<HijackStatus>("connecting");
  const dark = isDarkTheme();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      queueMicrotask(() => returnFocusRef.current?.focus());
    };
  }, [onClose]);
  return (
    <div className="mon-modal-backdrop" onClick={onClose} data-testid="monitor-hijack-modal">
      <div
        className="mon-modal mon-hijack-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${label} terminal for ${nodeId}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mon-modal-head">
          <span className="mon-kicker">
            {label}: <span className="mon-mono">{nodeId}</span> <span className="mon-dim">· {engine}</span>
          </span>
          <span className={`mon-conn tone-${HIJACK_STATUS_TONES[status]}`} data-status={status}>
            <ToneDot tone={HIJACK_STATUS_TONES[status]} pulse={status === "connected"} />
            {status}
          </span>
          <Chip onClick={onClose}>Close</Chip>
        </header>
        <HijackTerminal runId={runId} nodeId={nodeId} dark={dark} onStatus={setStatus} />
      </div>
    </div>
  );
}

export function NodeInspector({
  runId,
  node,
  scores,
  onResult,
}: {
  runId: string;
  node: TreeNode;
  scores: RunScores;
  onResult: (kind: "ok" | "err", text: string) => void;
}) {
  const nodeId = node.id ?? treeNodeKey(node);
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: node.iteration ?? 0 });
  const row = rowOf(output.data);
  const failure = nodeErrorOf(output.data);
  const isLive = !TERMINAL_NODE_TONES.has(String(node.status ?? ""));
  const toolCalls = asArray(node.toolCalls).filter(isRecord);
  // Structured agent metadata (declared assignment + what actually ran) when
  // the snapshot carries it; legacy rows may still hold a plain string.
  const agentInfo = isRecord(node.agent) ? node.agent : undefined;
  const agentName = agentInfo ? asString(agentInfo.name) : asString(node.agent);
  const agentEngine = agentInfo ? asString(agentInfo.engine) : undefined;
  const agentModel = agentInfo ? asString(agentInfo.model) : undefined;
  const agentRanOn = agentInfo && isRecord(agentInfo.ranOn) ? agentInfo.ranOn : undefined;
  const ranOnEngine = agentRanOn ? asString(agentRanOn.engine) : undefined;
  const ranOnModel = agentRanOn ? asString(agentRanOn.model) : undefined;
  const declaredLine = [agentEngine, agentModel].filter(Boolean).join(" · ");
  const ranOnLine = [ranOnEngine, ranOnModel].filter(Boolean).join(" · ");
  const agentChain = asArray(agentInfo?.chain)
    .filter(isRecord)
    .map((entry) => asString(entry.name) ?? [asString(entry.engine), asString(entry.model)].filter(Boolean).join(" · "))
    .filter(Boolean);
  const nodeAttempt = asNumber(node.attempt);
  const nodeMaxAttempts = asNumber(node.maxAttempts);
  // Hijack affordance: only nodes whose attempts recorded a resumable agent
  // session get a button (live run + live node = hand-off; settled run =
  // reopen the session post-mortem). Compute nodes never show one.
  const runQuery = useGatewayRun(runId);
  const runStatus = isRecord(runQuery.data) ? asString(runQuery.data.status) : undefined;
  const candidates = useHijackCandidates(runId, isLive);
  const candidate = hijackCandidateForNode(candidates, nodeId);
  const hijackAction = hijackActionFor(runStatus, isLive, candidate !== null);
  const [showHijack, setShowHijack] = useState(false);
  // Containers (parallel, sequence, loop, worktree, merge-queue, …) group
  // other nodes and never own a transcript or structured output — showing
  // those panels there is pure noise. Leaf kinds keep the full inspector.
  const kind = String(node.kind ?? "").toLowerCase();
  const isContainer = !["task", "agent", "compute", "static"].includes(kind) && (node.children?.length ?? 0) > 0;
  // Retry affordance: failed leaf tasks get a "Retry task" button. The RPC
  // resets the node (and everything that ran after it) with the same library
  // machinery as `smithers retry-task`, then resumes the run — so it is only
  // enabled once the run itself has settled (a live engine owns its state).
  const nodeFailed = toneForStatus(node.status) === "failed" && !isContainer;
  const retryEnabled = canRetryTask(node.status, runStatus);
  const [retryBusy, setRetryBusy] = useState(false);
  const retryTask = async () => {
    const confirmed = window.confirm(
      `Retry ${nodeId}? This resets the task (and every task that ran after it) and resumes the run.`,
    );
    if (!confirmed) return;
    setRetryBusy(true);
    try {
      const response = await fetch(
        `/v1/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ iteration: node.iteration ?? 0 }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      const envelope = isRecord(body) ? body : {};
      if (!response.ok || envelope.ok === false) {
        const error = isRecord(envelope.error) ? asString(envelope.error.message) : undefined;
        throw new Error(error ?? `retry failed (${response.status})`);
      }
      onResult("ok", `Retry requested for ${nodeId} — the run is resuming.`);
    } catch (error) {
      onResult("err", `Retry failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRetryBusy(false);
    }
  };
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const child of node.children ?? []) {
      const status = String(child.status ?? "unknown");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [node]);
  return (
    <aside className="mon-inspector" data-testid="monitor-inspector">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">Node</h2>
        {nodeFailed ? (
          <Button
            variant="outline"
            data-testid="monitor-retry-task"
            disabled={!retryEnabled || retryBusy}
            title={
              retryEnabled
                ? "Reset this task (and every task that ran after it), then resume the run"
                : "The run is still executing — pause or cancel it before retrying this task"
            }
            onClick={() => void retryTask()}
          >
            {retryBusy ? "Retrying…" : "Retry task"}
          </Button>
        ) : null}
        {hijackAction && candidate ? (
          <Button
            variant="outline"
            data-testid="monitor-hijack-button"
            data-hijack-kind={hijackAction.kind}
            title={
              hijackAction.kind === "hijack"
                ? `Take over this node's live ${candidate.engine} session in an embedded terminal`
                : `Reopen this node's recorded ${candidate.engine} session in an embedded terminal`
            }
            onClick={() => setShowHijack(true)}
          >
            {hijackAction.label}
          </Button>
        ) : null}
        <StatusTag status={node.status} />
      </header>
      {showHijack && hijackAction && candidate ? (
        <HijackModal
          runId={runId}
          nodeId={nodeId}
          label={hijackAction.label}
          engine={candidate.engine}
          onClose={() => setShowHijack(false)}
        />
      ) : null}
      <div className="mon-inspector-title">{node.cardLabel ?? node.name ?? nodeId}</div>
      <NodeWhatHappened runId={runId} nodeId={nodeId} iteration={node.iteration ?? 0} status={node.status} />
      <NodeScoreChips nodeId={nodeId} scores={scores} />
      <dl className="mon-meta-grid">
        <dt>id</dt>
        <dd className="mon-mono">{nodeId}</dd>
        <dt>kind</dt>
        <dd>{node.kind ?? "—"}</dd>
        {agentName ? (
          <>
            <dt>agent</dt>
            <dd>{agentName}</dd>
          </>
        ) : null}
        {declaredLine && declaredLine !== agentName ? (
          <>
            <dt>engine</dt>
            <dd className="mon-mono" data-testid="monitor-agent-engine">
              {declaredLine}
            </dd>
          </>
        ) : null}
        {ranOnLine && ranOnLine !== declaredLine ? (
          <>
            <dt>ran on</dt>
            <dd className="mon-mono" data-testid="monitor-agent-ran-on">
              {ranOnLine}
            </dd>
          </>
        ) : null}
        {agentChain.length > 1 ? (
          <>
            <dt>failover</dt>
            <dd className="mon-mono" data-testid="monitor-agent-chain">
              {agentChain.join(" → ")}
            </dd>
          </>
        ) : null}
        {typeof nodeAttempt === "number" && nodeAttempt > 0 ? (
          <>
            <dt>attempt</dt>
            <dd className="mon-mono" data-testid="monitor-agent-attempt">
              {typeof nodeMaxAttempts === "number" && nodeMaxAttempts > 0
                ? `${nodeAttempt} of ${nodeMaxAttempts}`
                : nodeAttempt}
            </dd>
          </>
        ) : null}
        {typeof node.iteration === "number" ? (
          <>
            <dt>iteration</dt>
            <dd className="mon-mono">{node.iteration}</dd>
          </>
        ) : null}
      </dl>
      {toolCalls.length > 0 ? (
        <>
          <h3 className="mon-kicker">Tool calls</h3>
          <div className="mon-toolcalls">
            {toolCalls.map((call, index) => (
              <div className="mon-toolcall" key={index}>
                <span className="mon-mono">{asString(call.name) ?? asString(call.tool) ?? "tool"}</span>
                <StatusTag status={asString(call.status) ?? asString(call.state)} />
              </div>
            ))}
          </div>
        </>
      ) : null}
      {failure && !isContainer ? (
        <>
          <h3 className="mon-kicker">Failure</h3>
          <div className="mon-banner tone-failed">
            {[failure.name, failure.code].filter(Boolean).join(" · ")}
            {typeof failure.attempt === "number" ? ` · attempt ${failure.attempt}` : ""}
            {failure.agent ? ` · ${failure.agent}` : ""}
          </div>
          <pre className="mon-output mon-failure">{failure.message}</pre>
        </>
      ) : null}
      {isContainer ? (
        <>
          <h3 className="mon-kicker">Children</h3>
          {childCounts.length > 0 ? (
            <div className="mon-child-rollup" data-testid="monitor-child-rollup">
              {childCounts.map(([status, count]) => (
                <span key={status} className="mon-child-stat">
                  <ToneDot tone={toneForStatus(status)} /> {count} {labelForStatus(status)}
                </span>
              ))}
            </div>
          ) : (
            <div className="mon-empty mon-dim">No children yet.</div>
          )}
          <div className="mon-dim mon-container-note">
            {String(node.kind ?? "container")} nodes group other nodes — select a task inside for its transcript and
            output.
          </div>
        </>
      ) : (
        <>
          <div className="mon-kicker-row">
            <h3 className="mon-kicker">{isLive ? "Live output" : "Transcript"}</h3>
            {hijackAction && candidate ? (
              <Button
                variant="outline"
                size="sm"
                className="mon-hijack-inline"
                data-testid="monitor-hijack-inline"
                title={
                  hijackAction.kind === "hijack"
                    ? `Take over this node's live ${candidate.engine} session in an embedded terminal`
                    : `Reopen this node's recorded ${candidate.engine} session in an embedded terminal`
                }
                onClick={() => setShowHijack(true)}
              >
                ⌁ {hijackAction.kind === "hijack" ? "Hijack terminal" : "Reopen terminal"}
              </Button>
            ) : null}
          </div>
          <NodeLiveOutput runId={runId} nodeId={nodeId} live={isLive} />
          <h3 className="mon-kicker">Output</h3>
          {row ? (
            <OutputFields row={row} />
          ) : output.loading ? (
            <div className="mon-empty mon-dim">
              <span className="mon-live-pending"><span className="mon-dot mon-dot-pulse" aria-hidden /> loading output…</span>
            </div>
          ) : (
            <div className="mon-empty mon-dim">
              {failure
                ? "The node failed before producing output."
                : isLive
                  ? <span className="mon-live-pending"><span className="mon-dot mon-dot-pulse" aria-hidden /> running — structured output lands here when the node finishes</span>
                  : "No output recorded for this node."}
            </div>
          )}
          <NodeDiffSection runId={runId} nodeId={nodeId} iteration={node.iteration ?? 0} enabled={!isLive} />
        </>
      )}
    </aside>
  );
}

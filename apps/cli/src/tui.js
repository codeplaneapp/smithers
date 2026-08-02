import { intro, log, outro, select, spinner, text, confirm, isCancel, cancel } from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  discoverWorkflows,
  resolvePackDirs,
  summarizeWorkflowInputSchema,
  workflowInputJsonSchema,
} from "./workflows.js";
import { findSmithersDb } from "./find-db.js";
import { mdxPlugin } from "./mdx-plugin.js";
import { openSmithersStore } from "smthrs/openSmithersStore";
import { parseJsonArgument } from "./json-args.js";
import { parseAgentEvent, parseNodeOutputEvent } from "./chat.js";
import { formatStreamText } from "./tui-format.js";
import { fuzzySelect } from "./fuzzy-select.js";
import { computeRunStateFromRow } from "@smthrs/db/runState";
import { DETACHED_RUN_LOG_FILE_ENV } from "./detachedRunLogEnv.js";
import { reapDetachedRunLogs } from "./reapDetachedRunLogs.js";
import { resolveDetachedRunLogFile } from "./resolveDetachedRunLogFile.js";
import { sanitizeTerminalText } from "@smthrs/tui/src/sanitizeTerminalText.ts";

export { formatStreamText } from "./tui-format.js";

/**
 * @typedef {object} RunCardStep
 * @property {string} label
 * @property {"persisted" | "running" | "waiting" | "failed" | "cancelled" | "pending"} status
 */
/**
 * @typedef {object} RunCardModel
 * @property {string} name
 * @property {string} shortId
 * @property {string} state
 * @property {string} prompt
 * @property {string} [highlight]
 * @property {RunCardStep[]} steps
 * @property {string[]} [approvalLines] - prominent pending-approval lines (see buildApprovalLines)
 * @property {string} footer
 */

// Node-level step vocabulary: glyph on the left, colored label on the right.
const STEP = {
  persisted: { symbol: pc.green("✓"), label: "PERSISTED", color: pc.dim },
  running: { symbol: pc.blue("↻"), label: "RUNNING", color: pc.blue },
  waiting: { symbol: pc.yellow("⏸"), label: "WAITING", color: pc.yellow },
  failed: { symbol: pc.red("✗"), label: "FAILED", color: pc.red },
  // A user-cancelled node is terminal but NOT a failure: dim/grey ⊘, never the
  // red ✗, so a deliberate cancel doesn't read as an error (mirrors the TUI).
  cancelled: { symbol: pc.dim("⊘"), label: "CANCELLED", color: pc.dim },
  pending: { symbol: pc.dim("○"), label: "PENDING", color: pc.dim },
};

// Run-state badge shown top-right in the header.
const STATE_BADGE = {
  running: pc.green,
  "waiting-approval": pc.yellow,
  "waiting-event": pc.yellow,
  "waiting-timer": pc.yellow,
  recovering: pc.cyan,
  failed: pc.red,
  succeeded: pc.green,
  cancelled: pc.dim,
};

// DB node.state → step vocabulary.
const NODE_STATUS = {
  "in-progress": "running",
  running: "running",
  finished: "persisted",
  done: "persisted",
  persisted: "persisted",
  failed: "failed",
  cancelled: "cancelled",
  pending: "pending",
  "waiting-event": "waiting",
  "waiting-timer": "waiting",
  "waiting-approval": "waiting",
};

// Run states at which the live loop stops watching (nothing will change without us).
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "waiting-approval"]);
const STOP_STATES = new Set([...TERMINAL_STATES, "stale", "orphaned"]);

const cols = () => process.stdout.columns || 80;
const ANSI_SGR_RE = /\x1B\[[0-9;]*m/g;
const visLen = (s) => s.replace(ANSI_SGR_RE, "").length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Elide `s` to at most `max` visible chars with an ellipsis. */
export function truncate(s, max) {
  if (!s) return s;
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Clack redraws in-place; oversized option windows can leave stale rows behind
 * on small terminals. Keep the picker within the current viewport.
 * @param {number} rows
 */
export function pickerMaxItems(rows) {
  return Math.max(1, Math.min(12, rows - 6));
}

/**
 * Build one-line clack select options by sharing a conservative terminal-width
 * budget between the label and hint.
 *
 * @param {import("./DiscoveredWorkflow.ts").DiscoveredWorkflow[]} workflows
 * @param {number} width
 */
export function buildWorkflowPickerOptions(workflows, width) {
  const lineBudget = Math.max(1, width - 12);
  return workflows.map((w) => {
    const rawLabel = w.displayName ?? w.id;
    const rawHint = typeof w.description === "string" ? w.description : "";
    const wantsHint = rawHint.length > 0 && lineBudget >= 24;
    const labelBudget = wantsHint ? Math.max(8, Math.min(lineBudget, Math.floor(lineBudget * 0.55))) : lineBudget;
    const label = truncate(rawLabel, labelBudget);
    const hintBudget = lineBudget - visLen(label) - 2;
    return {
      value: w.entryFile,
      label,
      hint: wantsHint && hintBudget > 8 ? truncate(rawHint, hintBudget) : undefined,
    };
  });
}

// Distinct colors so parallel agents' streams are visually separable, the way
// docker-compose / multiplexed log viewers tag each source.
const STREAM_PALETTE = [pc.cyan, pc.magenta, pc.green, pc.blue, pc.yellow, pc.red];
/** Stable color per nodeId, assigned in first-seen order. */
function makeNodeColorer() {
  const assigned = new Map();
  let next = 0;
  return (nodeId) => {
    if (!assigned.has(nodeId)) assigned.set(nodeId, STREAM_PALETTE[next++ % STREAM_PALETTE.length]);
    return assigned.get(nodeId);
  };
}

/**
 * Keep agent/tool stream output to one visual line so it cannot corrupt the
 * status-card layout around it.
 * @param {string} text
 */
export function normalizeStreamText(text) {
  return sanitizeTerminalText(text, { preserveSgr: true })
    .replace(/\s+$/g, "")
    .replace(/[\r\n]+/g, " ↵ ")
    .replace(/\t/g, "    ");
}

/** Bare node id for display: strip any `workflow:`-style qualifier prefix. */
export function displayNode(nodeId) {
  const id = String(nodeId ?? "·");
  const i = id.lastIndexOf(":");
  return i >= 0 ? id.slice(i + 1) : id;
}

/**
 * A completed tool phase ("[tool] X → Y", emitted by parseAgentEvent) is
 * redundant with the start line, so the stream skips it to halve tool-call noise.
 * @param {string} text
 */
export function isCompletedToolPhase(text) {
  // Completed = "[tool] <title> → <output>" (title has no ':' — a started call
  // with JSON args is "[tool] <title>: {…}", whose args may legitimately hold →).
  return /^\s*\[(?:tool|command)\]\s+[^:→\n]+\s→\s/.test(String(text));
}

const OUTPUT_META_KEYS = new Set([
  "runId",
  "nodeId",
  "iteration",
  "attempt",
  "run_id",
  "node_id",
  "createdAtMs",
  "updatedAtMs",
  "created_at_ms",
  "updated_at_ms",
]);

/** Strip smithers meta columns from a raw output row and compact to JSON. */
export function formatOutputRow(row) {
  if (!row || typeof row !== "object") return "";
  const data = {};
  for (const [k, v] of Object.entries(row)) {
    if (OUTPUT_META_KEYS.has(k) || v == null) continue;
    data[k] = v;
  }
  return Object.keys(data).length > 0 ? JSON.stringify(data) : "";
}

/**
 * Load a finished node's output and shape it into an `[output]` stream line so
 * task results are clearly labeled (not mistaken for agent chatter).
 * @returns {Promise<{ nodeId: string; text: string } | null>}
 */
async function loadOutputLine(adapter, runId, ev, outputTables) {
  try {
    const payload = JSON.parse(ev.payloadJson ?? "{}");
    const nodeId = String(payload.nodeId ?? "");
    const table = outputTables.get(nodeId);
    if (!table) return null;
    const row = await adapter.getRawNodeOutputForIteration(table, runId, nodeId, Number(payload.iteration ?? 0));
    const text = formatOutputRow(row);
    return text ? { nodeId, text: `[output] ${text}` } : null;
  } catch {
    return null;
  }
}

/**
 * Word-wrap `text` to at most `width` visible chars per line, hard-breaking
 * tokens longer than the width.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrapText(text, width) {
  const w = Math.max(1, width);
  const lines = [];
  let line = "";
  for (const word of String(text).split(/ +/)) {
    let token = word;
    if (!line) {
      while (visLen(token) > w) {
        const [chunk, rest] = splitVisible(token, w);
        lines.push(chunk);
        token = rest;
      }
      line = token;
    } else if (visLen(line) + 1 + visLen(token) <= w) {
      line += ` ${token}`;
    } else {
      lines.push(line);
      while (visLen(token) > w) {
        const [chunk, rest] = splitVisible(token, w);
        lines.push(chunk);
        token = rest;
      }
      line = token;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * Split after `width` visible chars without cutting through ANSI color codes.
 * @param {string} text
 * @param {number} width
 * @returns {[string, string]}
 */
function splitVisible(text, width) {
  let index = 0;
  let visible = 0;
  let head = "";
  while (index < text.length && visible < width) {
    const ansi = text.slice(index).match(/^\x1B\[[0-9;]*m/);
    if (ansi) {
      head += ansi[0];
      index += ansi[0].length;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint == null) break;
    const char = String.fromCodePoint(codePoint);
    head += char;
    index += char.length;
    visible += 1;
  }
  return [head, text.slice(index)];
}

/** One streamed log entry: colored node tag, dim gutter, body wrapped across lines. */
function printStreamLine(color, label, text) {
  const tagWidth = Math.max(1, Math.min(11, cols() - 4));
  const tag = color(truncate(label, tagWidth).padEnd(tagWidth));
  const cont = " ".repeat(tagWidth);
  const lines = wrapText(formatStreamText(text), Math.max(1, cols() - tagWidth - 4));
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(`${i === 0 ? tag : cont} ${pc.dim("│")} ${lines[i]}\n`);
  }
}

/**
 * A bottom-of-stream "agent working…" indicator. Animates on a TTY; a no-op when
 * piped, so replay/tests stay clean. clear() erases it before other output;
 * set() shows/updates it during quiet periods between events.
 * @returns {{ set: (text: string) => void; clear: () => void }}
 */
function createWorkingIndicator() {
  if (!process.stdout.isTTY) return { set() {}, clear() {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let timer = null;
  let msg = "";
  const paint = () => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r${pc.cyan(frames[i])} ${pc.dim(msg)}\x1B[K`);
  };
  return {
    set(text) {
      msg = text;
      if (!timer) {
        timer = setInterval(paint, 90);
        if (typeof timer.unref === "function") timer.unref();
      }
      paint();
    },
    clear() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write("\r\x1B[K");
    },
  };
}

/** Lay `left` and `right` out on one line, right-aligned to the gutter width. */
function padRow(left, right, width = cols() - 3) {
  const gap = Math.max(1, width - visLen(left) - visLen(right));
  return left + " ".repeat(gap) + right;
}

/** Dim `text`, with a single highlighted keyword box. */
function highlight(text, word) {
  if (!word) return pc.dim(text);
  const i = text.indexOf(word);
  if (i === -1) return pc.dim(text);
  return pc.dim(text.slice(0, i)) + pc.bgGreen(pc.black(` ${word} `)) + pc.dim(text.slice(i + word.length));
}

function shortId(runId) {
  // Run ids are usually short + meaningful (e.g. `run-abc123`); show them
  // whole, only eliding genuinely long ones from the end.
  return runId.length > 24 ? `${runId.slice(0, 21)}…` : runId;
}

/**
 * Format pending approvals as prominent card lines carrying the EXACT command
 * to resolve each one. With a single pending gate `smithers approve <runId>`
 * auto-detects the node; with several, each line pins its node via `--node`.
 *
 * @param {string} runId
 * @param {{ nodeId?: string }[] | null | undefined} approvals
 * @returns {string[]}
 */
export function buildApprovalLines(runId, approvals) {
  if (!Array.isArray(approvals) || approvals.length === 0) return [];
  return approvals.map((a) => {
    const nodeId = a?.nodeId ? String(a.nodeId) : "";
    const cmd =
      approvals.length > 1 && nodeId ? `smithers approve ${runId} --node ${nodeId}` : `smithers approve ${runId}`;
    const node = nodeId ? ` ${pc.dim(`(${displayNode(nodeId)})`)}` : "";
    return `${pc.yellow("approval needed")}${node} ${pc.dim("·")} ${pc.bold(cmd)}`;
  });
}

/**
 * Build the post-run next-step guidance printed when the interactive session
 * ends, phrased for an agent operator to relay ("Suggest to the user:").
 *
 * @param {{ runId: string; workflowId?: string; entryFile?: string; uiExists?: boolean }} opts
 * @returns {string[]}
 */
export function buildNextStepsLines({ runId, workflowId, entryFile, uiExists }) {
  const lines = [];
  if (uiExists) {
    lines.push(`smithers ui ${runId}  (open this run in its custom UI)`);
  } else if (workflowId) {
    // There is no generic run inspector behind `smithers ui <runId>`: the
    // command fails NO_UI until the workflow declares a custom UI. Lead with
    // AUTHORING it, mirroring buildAgentNextSteps (agentNextSteps.js) so the
    // two guidance surfaces cannot drift apart on this case again.
    lines.push(
      `author .smithers/ui/${workflowId}.tsx with the smthrs/gateway-react hooks, add \`<UI entry="../ui/${workflowId}.tsx" />\` to the workflow, then open it with \`smithers ui ${runId}\``,
    );
  } else {
    // Without a workflow id we cannot name the UI file to author, and
    // `smithers ui <runId>` would fail NO_UI — point at the full
    // control-plane UI instead.
    lines.push("smithers ui --app  (open the full Smithers control-plane UI)");
  }
  if (entryFile) lines.push(`smithers graph ${entryFile}  (visualize the workflow graph)`);
  lines.push(`smithers tree ${runId}  (inspect the run tree)`);
  lines.push("smithers workflow run create-workflow  (build a new workflow)");
  return lines;
}

/**
 * Whether a custom `smithers ui` surface exists for this workflow id. A
 * pack-relative `ui/<workflowId>.tsx` file is not enough: the same pack's
 * workflow must also declare `<UI entry="../ui/<workflowId>.tsx" />`.
 * @param {string | undefined} workflowId
 * @param {string} [cwd]
 */
export function customUiExists(workflowId, cwd = process.cwd()) {
  if (!workflowId) return false;
  try {
    const packDirs = [...resolvePackDirs(cwd).map(({ packDir }) => packDir), resolve(cwd, ".smithers")];
    return packDirs.some((packDir) => {
      const uiPath = resolve(packDir, "ui", `${workflowId}.tsx`);
      const workflowPath = resolve(packDir, "workflows", `${workflowId}.tsx`);
      if (!existsSync(uiPath) || !existsSync(workflowPath)) return false;
      const source = readFileSync(workflowPath, "utf8");
      return source.includes("<UI") && source.includes(`../ui/${workflowId}.tsx`);
    });
  } catch {
    return false;
  }
}

/**
 * Render a single run as a clack-native status card.
 * @param {RunCardModel} model
 */
export function renderRunCard(model) {
  const badge = (STATE_BADGE[model.state] ?? pc.dim)(String(model.state).toUpperCase());
  const rowWidth = Math.max(1, cols() - 3);
  const leftBudget = Math.max(1, rowWidth - visLen(badge) - 1);
  const idBudget = leftBudget >= 8 ? Math.min(24, Math.max(1, Math.floor(leftBudget / 3))) : 0;
  const idPart = idBudget > 0 ? ` ${pc.dim("·")} ${pc.dim(truncate(model.shortId, idBudget))}` : "";
  const titleBudget = Math.max(1, leftBudget - visLen(idPart));
  const title = `${pc.bold(truncate(model.name, titleBudget))}${idPart}`;
  intro(padRow(title, badge));

  log.message(`${pc.dim("you ›")} ${highlight(truncate(model.prompt, cols() - 10), model.highlight)}`);

  for (const step of model.steps) {
    const s = STEP[step.status] ?? STEP.pending;
    const label = truncate(step.label, Math.max(1, rowWidth - visLen(s.label) - 1));
    log.message(padRow(pc.reset(label), s.color(s.label)), { symbol: s.symbol });
  }

  for (const line of model.approvalLines ?? []) {
    log.message(line, { symbol: pc.yellow("⏸") });
  }

  outro(pc.dim(model.footer));
}

/**
 * Read a run from the DB and shape it into a card model.
 * @param {import("@smthrs/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} name
 * @param {string} promptText
 * @param {{ uiExists?: boolean }} [opts] - `uiExists`: a custom `smithers ui` surface
 *   exists for this workflow, so the footer advertises the exact command to open it.
 * @returns {Promise<RunCardModel | null>}
 */
export async function fetchCard(adapter, runId, name, promptText, opts = {}) {
  const run = await adapter.getRun(runId);
  if (!run) return null;
  const view = await computeRunStateFromRow(adapter, run).catch(() => ({ state: run.status }));
  const nodes = await adapter.listNodes(runId);
  const steps = nodes.map((n) => ({
    label: n.label ?? n.nodeId,
    status: NODE_STATUS[n.state] ?? "pending",
  }));
  // Pending approvals are the ONE thing the operator must act on for the run
  // to make progress, so they get prominent lines with the exact command.
  let approvals = [];
  if (typeof adapter.listPendingApprovals === "function") {
    try {
      approvals = await adapter.listPendingApprovals(runId);
    } catch {
      approvals = [];
    }
  }
  const footer = opts.uiExists
    ? `crash-safe · resumes from the last persisted step · custom UI: smithers ui ${runId}`
    : "crash-safe · resumes from the last persisted step";
  return {
    name: run.workflowName ?? name,
    shortId: shortId(runId),
    state: view.state,
    prompt: promptText,
    steps: steps.length ? steps : [{ label: "starting…", status: "pending" }],
    approvalLines: buildApprovalLines(runId, approvals),
    footer,
  };
}

/**
 * @param {number} ms
 * @param {Promise<Error>} [childFailure]
 * @returns {Promise<{ error: Error } | null>}
 */
async function sleepOrChildFailure(ms, childFailure) {
  if (ms <= 0) return null;
  if (!childFailure) {
    await sleep(ms);
    return null;
  }
  return Promise.race([sleep(ms).then(() => null), childFailure.then((error) => ({ error }))]);
}

/**
 * Signals that mean the monitor was asked to stop (or its terminal went away) —
 * a clean user quit, not a failure. Any OTHER terminating signal
 * (SIGSEGV/SIGABRT/SIGKILL/SIGBUS/SIGILL/SIGFPE/SIGQUIT…) means the monitor
 * crashed and must be reported as such, never as success.
 * @type {ReadonlySet<NodeJS.Signals>}
 */
const CLEAN_EXIT_SIGNALS = new Set(/** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"]));

/**
 * The TUI monitor traps external SIGINT/SIGTERM/SIGHUP, runs its terminal cleanup,
 * then exits with the conventional `128 + signo` code (SIGHUP 129, SIGINT 130,
 * SIGTERM 143 — see packages/tui/src/index.tsx). So a clean interrupt reaches the
 * parent as one of these EXIT CODES, not as a signal. Treat them as a clean quit,
 * mirroring CLEAN_EXIT_SIGNALS, so a Ctrl-C / terminal close is not misreported as
 * TUI_MONITOR_FAILED.
 * @type {ReadonlySet<number>}
 */
const CLEAN_EXIT_CODES = new Set([129, 130, 143]);

/**
 * Whether the TUI monitor child exited cleanly (user quit / interrupt / terminal
 * close) rather than failing to start or crashing. A genuine crash — a non-zero
 * exit code that is not one of the interrupt teardown codes, or a hard-kill signal
 * (SIGSEGV/SIGABRT/SIGKILL/…) — is NOT clean and must surface as a failure.
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 */
export function isCleanMonitorExit(code, signal) {
  if (code === null) {
    // Killed by a signal without running our teardown: clean only if it is an
    // interrupt/terminate/hangup, never a crash signal.
    return signal ? CLEAN_EXIT_SIGNALS.has(signal) : true;
  }
  return code === 0 || CLEAN_EXIT_CODES.has(code);
}

/**
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 */
function childExitError(code, signal) {
  const status = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
  return new Error(`Run process exited (${status}).`);
}

/**
 * Resolves if the detached child cannot keep producing the run we are waiting
 * for. The promise intentionally never rejects, so races do not create unhandled
 * rejections when the successful path wins first.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<Error>}
 */
export function childFailurePromise(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(childExitError(child.exitCode, child.signalCode));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(error);
    };
    const onError = (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    };
    const onExit = (code, signal) => {
      finish(childExitError(code, signal));
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/**
 * Wait for the workspace DB to exist, but stop immediately if the detached run
 * process exits first.
 *
 * The `backend` must match the one the detached child `up` run writes to (the
 * user's `--backend`), otherwise the launcher would poll a different store than
 * the run and time out (or watch the wrong one).
 *
 * @param {string} from
 * @param {{ timeoutMs?: number; intervalMs?: number; backend?: string }} opts
 * @param {Promise<Error>} childFailure
 * @returns {Promise<{ db?: Awaited<ReturnType<typeof openSmithersStore>>; error?: Error }>}
 */
async function waitForOpenDbOrChild(from, opts, childFailure) {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
  const intervalMs = Math.max(1, opts.intervalMs ?? 100);
  const backend = opts.backend || undefined;
  const startedAt = Date.now();
  let lastMissing;

  while (true) {
    try {
      const db = await openSmithersStore({ cwd: from, backend, mode: "read", wait: { timeoutMs: 0, intervalMs } });
      return { db };
    } catch (err) {
      if (err?.code !== "CLI_DB_NOT_FOUND") {
        return { error: err instanceof Error ? err : new Error(String(err)) };
      }
      lastMissing = err;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { error: lastMissing instanceof Error ? lastMissing : new Error(String(lastMissing)) };
    }
    const waited = await sleepOrChildFailure(Math.min(intervalMs, timeoutMs - elapsedMs), childFailure);
    if (waited?.error) {
      try {
        const db = await openSmithersStore({ cwd: from, backend, mode: "read", wait: { timeoutMs: 0, intervalMs } });
        return { db };
      } catch {}
      return waited;
    }
  }
}

/**
 * Poll until the run row exists (the detached run has begun writing).
 *
 * `spawnedAtMs` guards against a PRE-EXISTING row satisfying the wait: a
 * user-supplied `--run-id` that collides with an old run makes the detached
 * child die RUN_EXISTS (stderr goes only to the log file) while the stale row
 * here would read as "started" — the launcher would then monitor the OLD run.
 * When provided, a row only counts once its `createdAtMs` is at or after the
 * child spawn time (same machine, same clock; the child inserts the row after
 * it is spawned). Rows without a numeric `createdAtMs` are accepted as before:
 * only a DEFINITELY stale timestamp is rejected.
 */
export async function waitForRunRow(adapter, runId, timeoutMs, intervalMs, childFailure, spawnedAtMs) {
  const isFresh = (row) => {
    if (!row) return false;
    if (spawnedAtMs === undefined) return true;
    const createdAtMs = /** @type {{ createdAtMs?: unknown }} */ (row).createdAtMs;
    return typeof createdAtMs !== "number" || createdAtMs >= spawnedAtMs;
  };
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isFresh(await adapter.getRun(runId))) return { appeared: true };
    const elapsedMs = Date.now() - startedAt;
    const waited = await sleepOrChildFailure(Math.min(intervalMs, Math.max(0, timeoutMs - elapsedMs)), childFailure);
    if (waited?.error) {
      if (isFresh(await adapter.getRun(runId))) return { appeared: true };
      return { appeared: false, error: waited.error };
    }
  }
  return { appeared: false };
}

/**
 * Probe the workspace store for a run that already carries `runId`, so an
 * interactive launch with an explicit `--run-id` can fail RUN_EXISTS up front
 * (mirroring `up`'s own guard in index.js) instead of after spawning: the
 * detached child's RUN_EXISTS death (exit 4) is visible only in the log file,
 * while the pre-existing row would satisfy the run-row wait — without this
 * probe the launcher declares the OLD run "started" and monitors it.
 *
 * Conservative on purpose: only a POSITIVE match blocks the launch. A missing
 * store (fresh workspace, CLI_DB_NOT_FOUND) cannot collide, and any other
 * probe failure defers to the existing spawn-path error handling rather than
 * failing a launch the child might have survived.
 *
 * @param {string} runId
 * @param {{ cwd?: string; backend?: string; openStore?: typeof openSmithersStore }} [opts] - `openStore` injectable for tests
 * @returns {Promise<boolean>}
 */
export async function workspaceRunExists(runId, opts = {}) {
  const openStore = opts.openStore ?? openSmithersStore;
  let store;
  try {
    store = await openStore({
      cwd: opts.cwd ?? process.cwd(),
      backend: opts.backend,
      mode: "read",
      wait: { timeoutMs: 0 },
    });
  } catch {
    return false;
  }
  try {
    return Boolean(await store.adapter.getRun(runId));
  } catch {
    return false;
  } finally {
    try {
      store.cleanup();
    } catch {}
  }
}

/**
 * @param {import("node:child_process").ChildProcess | undefined} child
 */
function terminateDetachedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
  } catch {}
  try {
    child.kill("SIGTERM");
  } catch {}
}

/**
 * Own user cancellation during the spawn→announcement window of the
 * interactive launch, instead of leaving it to @clack/prompts.
 *
 * While the "Starting…" spinner runs, clack's block() holds stdin in RAW mode,
 * so keyboard Ctrl-C never raises SIGINT: it arrives as a \x03 keypress that
 * clack treats as a built-in cancel and answers with `process.exit(0)`. At
 * that point the detached run child (own process group, unref'd) keeps
 * executing — but the run id and log path have NOT been printed yet (they only
 * render at the spinner's stop), so the cancel would strand a silently
 * token-burning run discoverable only via `smithers ps`, while the launcher
 * exits 0. An external `kill -INT`/`-TERM` misbehaves differently: clack's
 * spinner handler prints "Canceled" and CONTINUES, opening the monitor moments
 * later. So both delivery paths need explicit handling.
 *
 * Every failure path in this same window already tears the child down
 * (terminateDetachedChild); these hooks make a user cancel honor the same
 * contract:
 *  - process "exit" (clack's raw-mode exit(0) delivers no signal): terminate
 *    the child group synchronously and say what was stopped and where the
 *    logs are, so the cancel is never silent.
 *  - SIGINT/SIGTERM (external kills clack would swallow-and-continue past):
 *    terminate, report, and exit with the conventional 130/143.
 *
 * `disarm()` removes every hook; the caller disarms once the launch leaves the
 * window (the run is announced with its id + log path, or a failure branch
 * already tore the child down), so a later cancel or monitor quit keeps the
 * durable run alive as designed.
 *
 * The process/write/exit seams are injectable so tests can drive the hooks
 * without killing the test runner.
 *
 * @param {{
 *   runId: string;
 *   logFile: string;
 *   terminate: () => void;
 *   write?: (line: string) => void;
 *   exit?: (code: number) => void;
 *   proc?: Pick<NodeJS.Process, "on" | "off">;
 * }} opts
 * @returns {{ disarm: () => void }}
 */
export function armLaunchCancellation({ runId, logFile, terminate, write, exit, proc }) {
  const target = proc ?? process;
  const writeLine = write ?? ((line) => process.stderr.write(line));
  const exitWith = exit ?? ((code) => process.exit(code));
  let armed = true;
  // Disarm BEFORE terminating so re-entry (a signal handler exiting fires the
  // "exit" hook too) can never double-kill or double-print.
  const stop = () => {
    if (!armed) return false;
    disarm();
    terminate();
    writeLine(`\nRun ${runId} stopped · logs → ${logFile}\n`);
    return true;
  };
  const onExit = () => {
    stop();
  };
  const onSigint = () => {
    if (stop()) exitWith(130);
  };
  const onSigterm = () => {
    if (stop()) exitWith(143);
  };
  function disarm() {
    armed = false;
    target.off("exit", onExit);
    target.off("SIGINT", onSigint);
    target.off("SIGTERM", onSigterm);
  }
  target.on("exit", onExit);
  target.on("SIGINT", onSigint);
  target.on("SIGTERM", onSigterm);
  return { disarm };
}

/**
 * Append-only live view of a run: re-renders the status card on every committed
 * frame, and streams agent chat + tool calls in between — each node colored so
 * parallel agents are easy to tell apart. Runs until the run reaches a terminal
 * state, pauses for approval, or the user hits Ctrl-C.
 *
 * @param {import("@smthrs/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} name
 * @param {string} promptText
 * @param {{ intervalMs?: number; childFailure?: Promise<Error>; uiExists?: boolean; renderCard?: (card: RunCardModel) => void; printLine?: (color: (text: string) => string, label: string, text: string) => void }} [opts]
 * @returns {Promise<{ state: string | undefined; error?: Error }>}
 */
export async function streamRun(adapter, runId, name, promptText, opts = {}) {
  const intervalMs = opts.intervalMs ?? 500;
  const childFailure = opts.childFailure;
  const renderCard = opts.renderCard ?? renderRunCard;
  const printLine = opts.printLine ?? printStreamLine;
  const colorFor = makeNodeColorer();
  const labels = new Map();
  const outputTables = new Map();
  const working = createWorkingIndicator();
  let lastSeq = -1;
  let stopped = false;
  const onSignal = () => {
    stopped = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let lastState;
  let lastRenderedState;
  const renderCurrentCard = async () => {
    const card = await fetchCard(adapter, runId, name, promptText, { uiExists: opts.uiExists });
    if (!card) return;
    renderCard(card);
    lastRenderedState = card.state;
  };
  try {
    await renderCurrentCard();

    while (!stopped) {
      working.clear();
      const run = await adapter.getRun(runId);
      let activeNode;
      if (run) {
        const view = await computeRunStateFromRow(adapter, run).catch(() => ({ state: run.status }));
        lastState = view.state;
        for (const node of await adapter.listNodes(runId)) {
          labels.set(node.nodeId, node.label ?? node.nodeId);
          if (node.outputTable) outputTables.set(node.nodeId, node.outputTable);
          if (node.state === "in-progress" || node.state === "running") {
            activeNode = node.label ?? displayNode(node.nodeId);
          }
        }
      }

      const events = await adapter.listEvents(runId, lastSeq, 500);
      // The card is rendered from the LIVE DB, so consecutive FrameCommitted
      // events in one batch would print identical duplicate cards. Collapse a
      // frame run into one render; a stream line in between resets the guard
      // so the card still re-appears after interleaved output.
      let renderedForFrame = false;
      for (const ev of events) {
        lastSeq = Number(ev.seq);
        if (ev.type === "FrameCommitted") {
          if (!renderedForFrame) {
            await renderCurrentCard();
            renderedForFrame = true;
          }
          continue;
        }
        if (ev.type === "NodeFinished") {
          const out = await loadOutputLine(adapter, runId, ev, outputTables);
          if (out) {
            printLine(colorFor(out.nodeId), labels.get(out.nodeId) ?? displayNode(out.nodeId), out.text);
            renderedForFrame = false;
          }
          continue;
        }
        const parsed = parseAgentEvent(ev) ?? parseNodeOutputEvent(ev);
        if (parsed?.text && !isCompletedToolPhase(parsed.text)) {
          const label = labels.get(parsed.nodeId) ?? displayNode(parsed.nodeId);
          printLine(colorFor(parsed.nodeId), label, parsed.text);
          renderedForFrame = false;
        }
      }

      if (lastState && STOP_STATES.has(lastState)) {
        if (lastRenderedState !== lastState) {
          await renderCurrentCard();
        }
        break;
      }
      if (lastState === "running" || lastState === "recovering") {
        working.set(`${activeNode ?? "agent"} ${pc.dim("·")} working…`);
      }
      const waited = await sleepOrChildFailure(intervalMs, childFailure);
      if (waited?.error) {
        working.clear();
        const finalRun = await adapter.getRun(runId);
        if (finalRun) {
          const view = await computeRunStateFromRow(adapter, finalRun).catch(() => ({ state: finalRun.status }));
          lastState = view.state;
          if (STOP_STATES.has(lastState)) {
            if (lastRenderedState !== lastState) {
              await renderCurrentCard();
            }
            break;
          }
        }
        return { state: lastState, error: waited.error };
      }
    }
  } finally {
    working.clear();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return { state: lastState };
}

/**
 * Close a loaded workflow's storage backend, mirroring `up`'s
 * `closeWorkflowBackend()` (apps/cli/src/index.js): an async
 * `openSmithersBackend` workflow exposes `close`, a sync `createSmithers`
 * workflow exposes `db.close`. Loading a workflow just to read its input schema
 * still opens that backend (pglite/postgres handles), so the interactive parent
 * must release it or it leaks for the parent's whole lifetime.
 * @param {{ close?: () => unknown; db?: { close?: () => unknown } } | null | undefined} workflow
 */
async function closeWorkflowBackend(workflow) {
  const close = workflow?.close ?? workflow?.db?.close;
  if (typeof close === "function") {
    await close.call(workflow?.close ? workflow : workflow.db);
  }
}

/**
 * Load a workflow module and return its declared input fields. Returns [] when
 * the workflow has no input schema or cannot be loaded (so we just run with no
 * input rather than blocking the user).
 * @param {string} entryFile
 * @returns {Promise<{ name: string; type: string; required: boolean; default?: unknown; enum?: unknown[]; description?: string }[]>}
 */
async function loadWorkflowInputFields(entryFile) {
  // Loading a workflow constructs its agents, which can log init warnings;
  // silence both streams so discovery cannot corrupt the interactive prompt.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  let mod;
  try {
    mdxPlugin();
    mod = await import(pathToFileURL(resolve(process.cwd(), entryFile)).href);
    const summary = summarizeWorkflowInputSchema(workflowInputJsonSchema(mod.default?.inputSchema));
    return summary?.fields ?? [];
  } catch {
    return [];
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    // Release the workflow's backend on BOTH success and error paths so
    // async openSmithersBackend workflows don't leak pglite/postgres handles
    // in the interactive parent (we only inspected the input schema).
    await closeWorkflowBackend(mod?.default).catch(() => {});
  }
}

/**
 * Sentinel returned by {@link promptForField} when the user chooses to leave an
 * OPTIONAL field unset. It is NOT `undefined` (which a text field also returns
 * for "no default, left blank") so the collector can tell "explicitly skipped"
 * apart and, either way, OMIT the key from the built input object — never coerce
 * an absent optional enum/boolean into a forced value.
 */
export const OMIT_FIELD = Symbol("smithers.tui.omitField");

/**
 * Whether a {@link promptForField} result should be written into the collected
 * input. Both `undefined` (blank optional text / no default) and
 * {@link OMIT_FIELD} (explicit skip of an optional enum/boolean) mean "leave the
 * key absent" so the workflow's own schema defaults/optionality apply.
 * @param {unknown} value
 */
export function includeFieldValue(value) {
  return value !== undefined && value !== OMIT_FIELD;
}

/**
 * Parse a free-text answer for an object/array-typed input field into its REAL
 * value. The collected inputs are JSON.stringify'd into the detached child's
 * `--input`, and the engine's run-input validation accepts strings for json
 * columns — so a raw answer string would NOT be rejected anywhere downstream
 * and would reach workflow code as the string '["a","b"]' instead of the array
 * ["a","b"]: a mid-run TypeError (`.map` on a string) or garbage iteration
 * (Object.entries over characters) with nothing pointing back at this prompt.
 * Parsing at the prompt is the only place the mistake is visible and fixable.
 *
 * Shape-checks ONLY the unambiguous declarations (an array-only field must get
 * an array, an object-only field a plain object); a union that also admits
 * other types accepts any parsed JSON.
 *
 * @param {string} name - field name (for the re-prompt message)
 * @param {string[]} types - the field's declared types (its `type` split on " | ")
 * @param {string} rawText - the trimmed, non-empty prompt answer
 * @returns {{ value: unknown } | { error: string }}
 */
export function parseJsonFieldValue(name, types, rawText) {
  const wantsArray = types.includes("array");
  const wantsObject = types.includes("object");
  const example = wantsArray && !wantsObject ? '["a","b"]' : '{"key":"value"}';
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // A union that ALSO admits a plain string keeps non-JSON text as-is —
    // only pure object/array declarations demand JSON spelling.
    if (types.includes("string")) return { value: rawText };
    return { error: `Enter valid JSON for ${name} (e.g. ${example}).` };
  }
  const isPlainObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (types.length === 1 && wantsArray && !Array.isArray(parsed)) {
    return { error: `Enter a JSON array for ${name} (e.g. ${example}).` };
  }
  if (types.length === 1 && wantsObject && !isPlainObject) {
    return { error: `Enter a JSON object for ${name} (e.g. ${example}).` };
  }
  return { value: parsed };
}

/**
 * Prompt for one input field with a clack control matched to its type, re-asking
 * (via clack's validate) until the value is valid. OPTIONAL enum/boolean fields
 * get a "(leave unset)" choice that returns {@link OMIT_FIELD} so absence stays
 * absence instead of being coerced (an optional enum forced to its first member,
 * an optional boolean forced to `false`). Object/array fields are entered as
 * JSON text and returned PARSED (see {@link parseJsonFieldValue}) so the value
 * that reaches the workflow is real data, not its string spelling.
 *
 * When `initial` is supplied (a CLI `--input`/`--prompt` value for this field),
 * it seeds the control's `initialValue` so a bare Enter KEEPS the supplied value
 * instead of falling through to the field's schema default — otherwise a workflow
 * whose field declares a `z.default` (e.g. create-workflow's `prompt`) would
 * clobber a task the user already typed on the CLI.
 *
 * @param {{ name: string; type: string; required: boolean; default?: unknown; enum?: unknown[]; description?: string }} field
 * @param {{ select: typeof select; confirm: typeof confirm; text: typeof text }} [prompts] - injectable clack controls (tests)
 * @param {unknown} [initial] - CLI-supplied value for this field, seeded as the control's initialValue
 * @returns {Promise<unknown | symbol>} coerced value, {@link OMIT_FIELD}, or a clack cancel symbol
 */
export async function promptForField(field, prompts = { select, confirm, text }, initial) {
  const types = String(field.type ?? "").split(" | ");
  const isNumber = types.includes("number") || types.includes("integer");
  const isInteger = types.includes("integer");
  const isBoolean = types.includes("boolean");
  const isJson = types.includes("object") || types.includes("array");
  const hasInitial = initial !== undefined;
  const suffix = field.required ? "" : pc.dim(" (optional)");
  const message = `${field.name}${suffix}${field.description ? ` ${pc.dim(field.description)}` : ""}`;
  const skipOption = { value: OMIT_FIELD, label: pc.dim("(leave unset)") };

  if (Array.isArray(field.enum) && field.enum.length > 0) {
    const options = field.enum.map((v) => ({ value: v, label: String(v) }));
    // Optional enums must offer an explicit escape hatch; a required enum
    // has none (one of its members must be chosen).
    if (!field.required) options.push(skipOption);
    return prompts.select({ message, options, ...(hasInitial ? { initialValue: initial } : {}) });
  }
  if (isBoolean) {
    // An optional boolean with NO declared default has three outcomes, not
    // two: true, false, or absent. A yes/no confirm can't express "absent"
    // (it forces false), so present a select with a skip choice instead.
    if (!field.required && field.default === undefined) {
      return prompts.select({
        message,
        options: [{ value: true, label: "true" }, { value: false, label: "false" }, skipOption],
        ...(hasInitial ? { initialValue: initial } : {}),
      });
    }
    return prompts.confirm({ message, initialValue: hasInitial ? initial === true : field.default === true });
  }
  const raw = await prompts.text({
    message,
    // A CLI-supplied value seeds the editable buffer so a bare Enter keeps it
    // rather than falling through to the field's schema default below.
    initialValue: hasInitial ? (isJson ? JSON.stringify(initial) : String(initial)) : undefined,
    // A JSON-typed default must render as its JSON spelling — String({})
    // would show the useless "[object Object]".
    placeholder:
      field.default !== undefined ? (isJson ? JSON.stringify(field.default) : String(field.default)) : undefined,
    validate: (value) => {
      const v = (value ?? "").trim();
      if (!v) {
        if (field.required && field.default === undefined) return "Required.";
        return undefined;
      }
      if (isJson) {
        const parsed = parseJsonFieldValue(field.name, types, v);
        return "error" in parsed ? parsed.error : undefined;
      }
      if (isInteger && !Number.isInteger(Number(v))) return `Enter a whole number for ${field.name}.`;
      if (isNumber && !Number.isFinite(Number(v))) return `Enter a number for ${field.name}.`;
      return undefined;
    },
  });
  if (isCancel(raw)) return raw;
  const v = (raw ?? "").trim();
  if (!v) return field.default;
  if (isJson) {
    // validate already guaranteed parseability; the fallthrough is defensive
    // (a prompts implementation that skips validate still can't smuggle a
    // raw string through as the field value).
    const parsed = parseJsonFieldValue(field.name, types, v);
    if ("value" in parsed) return parsed.value;
  }
  return isNumber ? Number(v) : v;
}

/**
 * Normalize the user-supplied CLI input for the interactive path into a plain
 * object, mirroring how `up`/`workflow run` resolve `--input`/`--prompt`
 * (`--input` JSON wins; otherwise `--prompt` maps to `{ prompt }`). Interactive
 * mode drives its prompts off the TTY stdin, so `--input -` (read JSON from
 * stdin) is unusable and is treated as no supplied input. Throws on invalid
 * `--input` JSON — including a non-object top-level payload (array/scalar/null) —
 * so the caller can fail fast before prompting. The interactive path builds an
 * input OBJECT from the workflow's fields, so a non-object `--input` is a usage
 * error, not something to silently drop.
 *
 * @param {Record<string, any> | undefined} options - the command's parsed options (`c.options`)
 * @returns {Record<string, unknown>}
 */
export function normalizeSuppliedInput(options) {
  const o = options ?? {};
  const raw =
    typeof o.input === "string" && o.input.length > 0
      ? o.input
      : o.prompt !== undefined
        ? JSON.stringify({ prompt: o.prompt })
        : undefined;
  if (raw === undefined || raw === "-") return {};
  const parsed = parseJsonArgument(raw, "input");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`;
    throw new Error(
      `--input must be a JSON object, but got ${kind}. Interactive mode builds the input object from the ` +
        `workflow's fields, so pass an object (e.g. '{"prompt":"…"}') or use --prompt.`,
    );
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Merge the CLI-supplied `--input`/`--prompt` values with the values collected by
 * the interactive prompts. Precedence: an explicit prompt answer OVERRIDES the
 * matching supplied key, and supplied keys that no prompt covered are PRESERVED
 * (so a supplied `--input` is never silently dropped just because a workflow has
 * no — or only some — input fields).
 *
 * @param {Record<string, unknown>} supplied - normalized CLI input
 * @param {Record<string, unknown> | null | undefined} prompted - values from the interactive prompts
 * @returns {Record<string, unknown>}
 */
export function mergeInteractiveInputs(supplied, prompted) {
  return { ...(supplied ?? {}), ...(prompted ?? {}) };
}

/**
 * Ask for a workflow's inputs before launching it. Returns the input object, or
 * null if the user cancelled mid-prompt.
 *
 * `supplied` carries any CLI `--input`/`--prompt` values (normalized): each
 * field's supplied value seeds its prompt so a bare Enter KEEPS it instead of
 * being clobbered by the field's schema default — otherwise a positional/`--prompt`
 * a user typed on the CLI would silently vanish for any field declaring a default.
 *
 * @param {{ entryFile: string }} workflow
 * @param {Record<string, unknown>} [supplied] - normalized CLI-supplied input
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function askWorkflowInputs(workflow, supplied = {}) {
  const fields = await loadWorkflowInputFields(workflow.entryFile);
  if (fields.length === 0) return {};
  log.message(pc.dim(`This workflow takes ${fields.length} input${fields.length === 1 ? "" : "s"}.`));
  const inputs = {};
  for (const field of fields) {
    const initial = Object.prototype.hasOwnProperty.call(supplied, field.name) ? supplied[field.name] : undefined;
    const value = await promptForField(field, undefined, initial);
    if (isCancel(value)) return null;
    // Skip blank optional text (undefined) and explicitly-skipped optional
    // enum/boolean (OMIT_FIELD) so absent input stays absent.
    if (includeFieldValue(value)) inputs[field.name] = value;
  }
  return inputs;
}

/**
 * Resolve the full-screen TUI monitor entry point through the installed
 * `@smthrs/tui` package (its `smithers-mon` bin), so it works for
 * published installs — not just from a relative path inside this monorepo.
 * Returns null when the package can't be resolved (e.g. it wasn't installed);
 * the caller then fails loudly with TUI_MONITOR_UNAVAILABLE (there is no inline
 * stream fallback) while leaving the detached run running.
 * @returns {string | null}
 */
export function resolveTuiEntry() {
  try {
    const pkgUrl = import.meta.resolve("@smthrs/tui/package.json");
    const pkgPath = fileURLToPath(pkgUrl);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["smithers-mon"];
    if (!bin) return null;
    return resolve(dirname(pkgPath), bin);
  } catch {
    return null;
  }
}

/**
 * Build the child environment for the TUI monitor: point it at the real CLI
 * entry (SMITHERS_CLI, for gateway autostart/hijack), and forward the gateway
 * URL, storage backend, and auth token.
 *
 * The auth token is threaded as SMITHERS_TOKEN because the monitor resolves its
 * bearer from `--token`/`SMITHERS_TOKEN`/`SMITHERS_API_KEY`. Without this an
 * explicit CLI `--auth-token` would be dropped, leaving the monitor's gateway
 * client unauthenticated while the gateway (which enables auth once a token is
 * set) rejects every RPC/WS call.
 *
 * `workspaceRoot` is forwarded as SMITHERS_WORKSPACE_ROOT so the monitor keys
 * the workspace-gateway state file off the SAME resolved workspace root the CLI
 * used (its `resolveGatewayWorkspace`), instead of re-deriving it from the
 * child's cwd — which a `smithers-mon` launched from a subdirectory would get
 * wrong, missing the running singleton and autostarting a doomed second gateway.
 *
 * @param {NodeJS.ProcessEnv} baseEnv - env to extend (usually `process.env`)
 * @param {{ cliIndexPath: string; gatewayUrl?: string; backend?: string; authToken?: string; workspaceRoot?: string }} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function buildTuiMonitorEnv(baseEnv, { cliIndexPath, gatewayUrl, backend, authToken, workspaceRoot }) {
  const env = { ...baseEnv, SMITHERS_CLI: cliIndexPath };
  if (gatewayUrl) env.SMITHERS_GATEWAY_URL = gatewayUrl;
  if (backend) env.SMITHERS_BACKEND = backend;
  if (authToken) env.SMITHERS_TOKEN = authToken;
  if (workspaceRoot) env.SMITHERS_WORKSPACE_ROOT = workspaceRoot;
  return env;
}

/**
 * Resolve the workspace root the same way the CLI's gateway commands do
 * (index.js `resolveGatewayWorkspace`): the nearest local `.smithers` pack's
 * parent, else the directory holding the nearest `smithers.db`. Forwarded to the
 * monitor as SMITHERS_WORKSPACE_ROOT so its per-workspace gateway state lookup
 * hashes the same key the daemon wrote. Returns undefined when neither anchor
 * exists (the monitor then falls back to its own cwd walk-up).
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
export function resolveMonitorWorkspaceRoot(cwd = process.cwd()) {
  const localPackDir = resolvePackDirs(cwd).find((dir) => dir.scope === "local")?.packDir;
  if (localPackDir) return dirname(localPackDir);
  try {
    return dirname(findSmithersDb(cwd));
  } catch {
    return undefined;
  }
}

/**
 * Spawn the full-screen TUI monitor as a foreground child process.
 * Inherits the current TTY (stdio: "inherit") and resolves when the child exits,
 * carrying its exit code/signal so the caller can distinguish a clean user quit
 * (code 0 / killed by signal) from a startup failure (non-zero code).
 *
 * @param {string} tuiEntry - absolute path to the TUI monitor entry (smithers-mon bin)
 * @param {string} runId
 * @param {string} cliIndexPath - absolute path to apps/cli/src/index.js (passed as
 *   SMITHERS_CLI so the TUI can start the Gateway via the real CLI entry point)
 * @param {string} [gatewayUrl] - gateway base URL the TUI should connect to
 * @param {string} [backend] - storage backend the run uses (`--backend`); forwarded
 *   as SMITHERS_BACKEND so the TUI's autostarted gateway opens the SAME store the
 *   detached run writes to instead of the default sqlite one.
 * @param {string} [authToken] - explicit `--auth-token`; forwarded as SMITHERS_TOKEN.
 * @returns {{ exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; terminate: () => void }}
 *   `exit` resolves when the monitor child exits (or rejects if it fails to spawn);
 *   `terminate` hard-stops the monitor (used when the detached run dies out from
 *   under it) and is a no-op once it has already exited.
 */
function launchTuiMonitor(tuiEntry, runId, cliIndexPath, gatewayUrl, backend, authToken) {
  const env = buildTuiMonitorEnv(process.env, {
    cliIndexPath,
    gatewayUrl,
    backend,
    authToken,
    workspaceRoot: resolveMonitorWorkspaceRoot(),
  });
  const child = spawn("bun", [tuiEntry, runId], { stdio: "inherit", env });
  const exit = new Promise((resolve, reject) => {
    child.once("error", (err) => reject(err));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    exit,
    terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  };
}

/**
 * Keep supervising the detached run child while the full-screen monitor is up.
 *
 * The monitor only reflects the last live gateway state; it does not itself know
 * whether the detached run *process* is still alive. So while it runs we also
 * watch `childFailure`. Whichever settles first decides the outcome:
 *
 * - The monitor exits first (a normal user quit / interrupt): return its exit so
 *   the caller applies the usual `isCleanMonitorExit` handling.
 * - The detached child dies first: re-read the run row. If the run is already in
 *   a stop state (terminal / waiting-approval / stale / orphaned — `STOP_STATES`),
 *   the run legitimately ended, so leave the monitor up for the user to inspect
 *   the final state and return its eventual exit. Otherwise the child died
 *   prematurely, so terminate the monitor and return the failure error.
 *
 * `childFailure` never rejects (see `childFailurePromise`), so the race adds no
 * unhandled rejections; the losing branch is simply abandoned. `monitor.exit`
 * CAN reject (a spawn/startup failure — `launchTuiMonitor` rejects on the child's
 * `error` event), so its race arm has an explicit rejection handler: rather than
 * letting a startup failure throw out of the structured failure path (as an
 * unhandled rejection) after the run already launched, it is folded into a
 * `{ monitorError }` outcome the caller reports loudly — while LEAVING the
 * still-running detached run alive and observable (`smithers ps` / the log file).
 *
 * @param {{ exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; terminate: () => void }} monitor
 * @param {Promise<Error>} childFailure
 * @param {{ getRun: (runId: string) => Promise<unknown> }} adapter
 * @param {string} runId
 * @returns {Promise<{ exit?: { code: number | null; signal: NodeJS.Signals | null }; error?: Error; monitorError?: Error }>}
 */
export async function superviseTuiMonitor(monitor, childFailure, adapter, runId) {
  const outcome = await Promise.race([
    monitor.exit.then(
      (exit) => ({ kind: "exit", exit }),
      (error) => ({ kind: "monitor-error", error }),
    ),
    childFailure.then((error) => ({ kind: "child", error })),
  ]);
  if (outcome.kind === "exit") {
    return { exit: outcome.exit };
  }
  if (outcome.kind === "monitor-error") {
    // The monitor process failed to START (e.g. `bun` missing / spawn error)
    // AFTER the run already launched. Surface it as a structured monitor
    // error — no unhandled rejection, single return path — so the caller can
    // fail loudly while leaving the running detached run alive.
    return { monitorError: outcome.error };
  }
  // The detached run child exited while the monitor was up. Re-read the run
  // state to tell a legitimate end from a premature death.
  let run = null;
  try {
    run = await adapter.getRun(runId);
  } catch {}
  let state;
  if (run) {
    const view = await computeRunStateFromRow(adapter, run).catch(() => ({ state: run.status }));
    state = view.state;
  }
  if (state && STOP_STATES.has(state)) {
    // Run legitimately reached a stop state; keep the monitor up until the
    // user quits, then hand its exit back to the caller. `monitor.exit` CAN
    // reject (a late spawn failure racing the child's exit — e.g. `bun`
    // missing / ENOENT); fold that into a structured `{ monitorError }`
    // instead of throwing the raw error out of here, so the caller emits the
    // monitorStartFailure guidance rather than a generic uncaught command error.
    return monitor.exit.then(
      (exit) => ({ exit }),
      (error) => ({ monitorError: error }),
    );
  }
  // Child died with the run still in flight — tear the monitor down and fail.
  monitor.terminate();
  return { error: outcome.error };
}

/**
 * Failure descriptors for the two "the full-screen monitor cannot run" paths
 * in runTuiCommand: the monitor child failed to start (spawn error), or its
 * package (@smthrs/tui) could not be resolved at all.
 *
 * Both happen AFTER the detached run launched, and the run is durable and
 * still executing — so the launcher must NOT kill it. (An earlier version
 * SIGTERM'd the run's whole process group on these paths while telling the
 * user to reattach to it; commit 871e3d9e9a introduced the kill and the
 * contradictory wording in the same change. The sibling monitor exit-code
 * failure branches always left the run alive.) Neither path may suggest
 * `smithers-mon` either: in the unresolvable case that bin belongs to the
 * very package that failed to resolve, so it cannot be run. Point at
 * surfaces that always work instead: `smithers ps` / `smithers inspect` and
 * the run's log file.
 *
 * @param {Error} error
 * @param {string} runId
 * @param {string} logFile
 */
export function monitorStartFailure(error, runId, logFile) {
  return {
    code: "TUI_MONITOR_FAILED",
    message:
      `The run monitor failed to start: ${error?.message ?? String(error)}. ` +
      `The run is still running detached; watch it with \`smithers ps\` / \`smithers inspect ${runId}\` or see ${logFile}.`,
    exitCode: 1,
    runId,
    logFile,
  };
}

/**
 * See {@link monitorStartFailure} for why the run stays alive and why the
 * guidance must not mention `smithers-mon`.
 *
 * @param {string} runId
 * @param {string} logFile
 */
export function monitorUnavailableFailure(runId, logFile) {
  return {
    code: "TUI_MONITOR_UNAVAILABLE",
    message:
      "The run monitor package (@smthrs/tui) could not be resolved, so the full-screen monitor can't launch. " +
      `The run is still running detached; watch it with \`smithers ps\` / \`smithers inspect ${runId}\` or see ${logFile}.`,
    exitCode: 1,
    runId,
    logFile,
  };
}

/**
 * Resolve the gateway base URL the monitor will READ from, mirroring the TUI's
 * own resolution (SMITHERS_GATEWAY_URL, else the local default on
 * SMITHERS_GATEWAY_PORT/7331). Used for the parent-side run-visibility check
 * only — the pinned URL, not this computed default, is what gets forwarded as
 * SMITHERS_GATEWAY_URL (so an unpinned monitor still autostarts its own).
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveMonitorGatewayBase(env) {
  const pinned =
    typeof env.SMITHERS_GATEWAY_URL === "string" && env.SMITHERS_GATEWAY_URL.length > 0
      ? env.SMITHERS_GATEWAY_URL.replace(/\/+$/, "")
      : undefined;
  if (pinned) return pinned;
  const port = parseMonitorGatewayPort(env.SMITHERS_GATEWAY_PORT);
  return `http://127.0.0.1:${port}`;
}

/**
 * Parse SMITHERS_GATEWAY_PORT for the parent-side monitor check, mirroring the
 * TUI's own validation (@smthrs/tui `isValidGatewayPort`): a legal
 * TCP port is an integer in 1..65535. Unset/blank falls back to the 7331 default;
 * a set-but-invalid value throws a clear error instead of yielding an unreachable
 * http://127.0.0.1:70000 the monitor's health probe can never connect to.
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseMonitorGatewayPort(raw) {
  if (raw === undefined || raw.trim() === "") return 7331;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid SMITHERS_GATEWAY_PORT "${raw}" (expected an integer 1-65535)`);
  }
  return port;
}

/**
 * Resolve the bearer token the monitor authenticates with, mirroring the TUI:
 * explicit `--auth-token`, then SMITHERS_TOKEN, then SMITHERS_API_KEY.
 * @param {string | undefined} authToken
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveMonitorToken(authToken, env) {
  const token = authToken || env.SMITHERS_TOKEN || env.SMITHERS_API_KEY;
  return token && token.length > 0 ? token : undefined;
}

/**
 * Per-request timeout for the gateway health/RPC probes. Each individual fetch
 * must settle well UNDER the overall 10s/30s startup budget: a process that binds
 * the port but never writes a response would otherwise hang a single request
 * (and the whole budget) indefinitely. On timeout the AbortSignal rejects the
 * fetch, which the callers classify as a RETRYABLE miss so the outer poll keeps
 * trying within the budget instead of blocking forever on one dead socket.
 */
const GATEWAY_REQUEST_TIMEOUT_MS = 3000;

/**
 * A gateway probe failure tagged with whether the caller should keep polling
 * (`retryable: true`) through it or fail fast (`retryable: false`). Connection
 * refused, startup-not-ready, timeout/abort, and 5xx are retryable; auth
 * (401/403) and malformed/protocol responses and other 4xx are NOT — retrying
 * those only stalls until the whole budget elapses and then reports a misleading
 * backend/workspace mismatch instead of the real cause.
 */
export class GatewayProbeError extends Error {
  /** @param {string} message @param {boolean} retryable */
  constructor(message, retryable) {
    super(message);
    this.name = "GatewayProbeError";
    this.retryable = retryable;
  }
}

/**
 * Whether a Gateway answers its `/health` probe at `base` (i.e. one is already
 * listening there and the monitor would REUSE it rather than autostart its own).
 * A per-request timeout means a bound-but-unresponsive port reports "not healthy"
 * quickly (the caller then falls through to its retry/autostart path) instead of
 * hanging the whole startup budget on one stuck socket.
 * @param {string} base
 * @param {string} [token]
 * @param {{ fetchImpl?: typeof fetch; timeoutMs?: number }} [opts]
 */
export async function gatewayHealthy(base, token, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS;
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  return fetchImpl(`${base}/health`, { headers, signal: AbortSignal.timeout(timeoutMs) }).then(
    (r) => r.ok,
    () => false,
  );
}

/**
 * Fetch a run from a Gateway over its HTTP RPC (same wire shape as `smithers ui`).
 * Returns the run payload, `null` when the gateway does not (yet) serve it, and
 * THROWS a {@link GatewayProbeError} otherwise — tagged `retryable` so the caller
 * keeps polling through a transient blip (connection refused, startup-not-ready,
 * timeout/abort, 5xx, run-not-found) but fails FAST on a definitive miss (auth
 * 401/403, malformed/protocol frame, other 4xx) rather than stalling the budget.
 *
 * A per-request timeout (AbortSignal.timeout) guarantees a bound-but-hung port
 * rejects promptly as a retryable miss instead of blocking the whole budget.
 *
 * @param {string} base - gateway base URL
 * @param {string} runId
 * @param {string} [token] - bearer when the gateway requires auth
 * @param {{ fetchImpl?: typeof fetch; timeoutMs?: number }} [opts]
 * @returns {Promise<unknown | null>}
 */
export async function gatewayGetRun(base, runId, token, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(`${base}/v1/rpc/getRun`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // No HTTP response at all: connection refused, DNS/socket reset, or our
    // per-request timeout aborted the fetch. The gateway is still coming up or
    // briefly unreachable — retryable so the poll keeps trying in-budget.
    const reason = err instanceof Error ? err.message : String(err);
    throw new GatewayProbeError(`Gateway at ${base} is not reachable yet (${reason}).`, true);
  }
  // Auth is DEFINITIVE: a wrong/missing token never starts working by retrying,
  // so fail fast with an accurate message instead of stalling the whole budget.
  if (res.status === 401 || res.status === 403) {
    throw new GatewayProbeError(
      `Gateway at ${base} rejected auth (${res.status}); check --token/SMITHERS_TOKEN/SMITHERS_API_KEY.`,
      false,
    );
  }
  // 5xx: the gateway is up but transiently erroring (still starting/restarting) —
  // keep polling within the budget.
  if (res.status >= 500) {
    throw new GatewayProbeError(`Gateway at ${base} returned HTTP ${res.status} for getRun; still starting.`, true);
  }
  const frame = await res.json().catch(() => null);
  if (!frame || frame.type !== "res") {
    // A non-frame body on a non-5xx status is a protocol/routing mismatch (wrong
    // server, a proxy error page): retrying will not turn it into a valid frame.
    throw new GatewayProbeError(`Gateway at ${base} returned an invalid response for getRun.`, false);
  }
  if (!frame.ok) {
    const code = frame.error?.code;
    // Defense in depth if the gateway ever returns an auth error frame with a
    // 200 status: still treat it as the fast-fail auth case.
    if (code === "Unauthorized" || code === "Forbidden") {
      throw new GatewayProbeError(
        `Gateway at ${base} rejected auth (${code}); check --token/SMITHERS_TOKEN/SMITHERS_API_KEY.`,
        false,
      );
    }
    // A run this gateway does not (yet) serve reports RunNotFound; treat it as a
    // not-there-yet miss so the poll keeps trying and ultimately surfaces the
    // backend/workspace-mismatch guidance. Any OTHER RPC error is a real
    // protocol/backend fault — fail fast.
    if (code === "RunNotFound" || res.status === 404) return null;
    throw new GatewayProbeError(frame.error?.message ?? `Gateway at ${base} returned an RPC error for getRun.`, false);
  }
  return frame.payload ?? null;
}

/**
 * Validate that the Gateway the monitor will READ from actually serves this run.
 *
 * The monitor reuses any healthy Gateway at the default address before
 * autostarting its own — but a stray Gateway already listening there may be bound
 * to a DIFFERENT backend/workspace. The detached run then writes to one store
 * while the monitor reads another, so the monitor shows a silently empty/wrong
 * run. Poll `getRun(runId)` against the connected Gateway within the startup
 * budget; if the run never appears, fail fast with a clear, actionable error
 * instead. RETRYABLE blips (connection refused, startup-not-ready, timeout/abort,
 * 5xx, run-not-found) are swallowed and retried until the timeout so a
 * truly-serving gateway that is briefly slow still passes — but a DEFINITIVE
 * failure (auth 401/403, malformed/protocol response, other 4xx; any thrown
 * error whose `retryable` is explicitly `false`) fails IMMEDIATELY with its
 * accurate message rather than waiting out the budget and then blaming a
 * backend/workspace mismatch.
 *
 * Pure/injected: `getRunOnGateway`, `now`, and `sleep` are all supplied so the
 * poll is unit-testable with a fake clock and no real network.
 *
 * @param {(runId: string) => Promise<unknown>} getRunOnGateway - fetch the run via the gateway
 * @param {string} runId
 * @param {string} gatewayUrl - gateway base the monitor connects to (for the message)
 * @param {{ timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false; message: string }>}
 */
export async function validateGatewayServesRun(getRunOnGateway, runId, gatewayUrl, opts = {}) {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 10_000);
  const intervalMs = Math.max(1, opts.intervalMs ?? 250);
  const now = opts.now ?? Date.now;
  const sleepFn = opts.sleep ?? sleep;
  const startedAt = now();
  while (true) {
    try {
      if (await getRunOnGateway(runId)) return { ok: true };
    } catch (err) {
      // A DEFINITIVE failure (auth rejected, malformed/protocol response)
      // never succeeds by retrying — surface it immediately with its accurate
      // message instead of stalling the whole budget and then reporting a
      // misleading backend/workspace mismatch. Everything else (connection
      // refused, startup-not-ready, timeout/abort, 5xx, run-not-found) is a
      // transient blip while the gateway settles; keep polling until timeout.
      if (err && typeof err === "object" && /** @type {{ retryable?: unknown }} */ (err).retryable === false) {
        return { ok: false, message: /** @type {{ message?: string }} */ (err).message ?? String(err) };
      }
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return {
        ok: false,
        message:
          `Gateway at ${gatewayUrl} does not serve run ${runId}; it may be on a ` +
          `different backend/workspace. Point the monitor at the right one with ` +
          `--gateway <url>, or stop the stray gateway so the monitor can start its own.`,
      };
    }
    await sleepFn(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}

/**
 * Serialize the launch options a user passed to `up`/`workflow run --interactive`
 * into the argv for the detached child `up` run the monitor watches, so the
 * interactive path honors the same sandbox/execution/logging flags as a normal
 * `up` instead of silently dropping them.
 *
 * Options that only make sense for a one-shot/foreground/server run are
 * intentionally excluded: `--detach` (the interactive path always detaches its
 * own child), `--interactive`, the `--serve`/`--supervise*`/`--host`/`--port`/
 * `--metrics`/`--auth-token`/`--insecure` HTTP-server family (the TUI provides
 * monitoring through its own gateway), and the internal durable resume-claim
 * flags. Workflow inputs are threaded via the already-prompted `inputs` object,
 * so the CLI `--input`/`--prompt` are handled there, not here.
 *
 * @param {string} indexPath - absolute path to apps/cli/src/index.js
 * @param {string} entryFile - workflow entry file to run
 * @param {string} runId - resolved run id
 * @param {Record<string, unknown> | null | undefined} inputs - prompted workflow inputs
 * @param {Record<string, any>} [options] - the command's parsed options (`c.options`)
 * @returns {string[]} argv after the `bun` executable (starting with `indexPath`)
 */
export function buildDetachedUpArgs(indexPath, entryFile, runId, inputs, options = {}) {
  const args = [indexPath, "up", entryFile, "--run-id", runId];
  if (inputs && Object.keys(inputs).length > 0) {
    args.push("--input", JSON.stringify(inputs));
  }
  const o = options ?? {};
  if (o.maxConcurrency) args.push("--max-concurrency", String(o.maxConcurrency));
  if (o.root) args.push("--root", String(o.root));
  if (o.log === false) args.push("--no-log");
  if (o.logDir) args.push("--log-dir", String(o.logDir));
  if (o.allowNetwork) args.push("--allow-network");
  if (o.maxOutputBytes) args.push("--max-output-bytes", String(o.maxOutputBytes));
  if (o.toolTimeoutMs) args.push("--tool-timeout-ms", String(o.toolTimeoutMs));
  if (o.hot) args.push("--hot");
  // Annotations must be RESOLVED before this point (see
  // resolveInteractiveAnnotations): the stdin `-` sentinel is rejected in the
  // interactive parent because the detached child's stdin is `ignore`d, so a raw
  // `-` would make it read empty stdin and fail. Defense-in-depth: never forward
  // a bare `-` even if a caller bypassed the parent validation.
  if (o.annotations && o.annotations !== "-") args.push("--annotations", String(o.annotations));
  if (o.startedByHarness) args.push("--started-by-harness", String(o.startedByHarness));
  if (o.startedBySession) args.push("--started-by-session", String(o.startedBySession));
  if (o.startedByPrompt !== undefined) args.push("--started-by-prompt", String(o.startedByPrompt));
  if (o.backend) args.push("--backend", String(o.backend));
  // `--no-post-failure` opts OUT of the default-on post-failure autopsy. The
  // detached child re-parses its own argv with the default (true), so dropping
  // the flag here would auto-launch the very background agent workflow the
  // user disabled. Mirrors the non-interactive detach path (index.js).
  if (o.postFailure === false) args.push("--no-post-failure");
  return args;
}

/**
 * Interactive-mode option-compatibility audit. `up`/`workflow run --interactive`
 * ALWAYS starts a fresh run detached and watches it in the full-screen TUI, so a
 * whole class of `up` options is meaningless — or actively wrong — here. Rather
 * than silently DROPPING them (which stranded users who passed
 * `--resume`/`--serve`/etc. and got a surprising fresh run or a no-op), reject
 * them up front with a clear message.
 *
 * Disposition of EVERY `up` option in interactive mode (keep in sync with
 * `upRunOptions` in index.js):
 *   FORWARD to the detached child (buildDetachedUpArgs): `--run-id`, `--root`,
 *     `--backend`, `--max-concurrency`, `--log`/`--no-log`, `--log-dir`,
 *     `--allow-network`, `--max-output-bytes`, `--tool-timeout-ms`, `--hot`,
 *     `--post-failure`/`--no-post-failure`, and `--started-by-*`.
 *   RESOLVE in the parent, never forwarded raw: `--input`/`--prompt` (parsed into
 *     the prompted inputs object; the `-` stdin sentinel is treated as no input),
 *     `--annotations` (validated by resolveInteractiveAnnotations; `-` rejected
 *     because the prompts own the TTY), `--auth-token` (consumed as the monitor's
 *     gateway bearer via SMITHERS_TOKEN, not forwarded to the child).
 *   REJECT (this function): `--detach` (interactive already detaches), `--resume`
 *     / `--force` (interactive always starts a NEW run), the internal durable
 *     resume-claim flags, and the whole HTTP-server family (`--serve`,
 *     `--supervise*`, `--host`, `--port`, `--metrics`, `--insecure`) — the TUI
 *     serves monitoring through its own gateway.
 *
 * @param {Record<string, any> | undefined} options - the command's parsed options (`c.options`)
 * @returns {{ code: string; message: string; exitCode: number } | null} a reject
 *   descriptor when an incompatible option was passed, else null
 */
export function rejectIncompatibleInteractiveOptions(options) {
  const o = options ?? {};
  /** @type {string[]} */
  const messages = [];
  if (o.detach) {
    messages.push(
      "--detach is redundant with --interactive: the interactive monitor already runs the workflow detached and watches it.",
    );
  }
  if (o.resume !== undefined && o.resume !== false) {
    messages.push(
      "--resume is not supported with --interactive, which always STARTS a new run. Resume non-interactively: smithers up <workflow> --resume <run-id>.",
    );
  }
  if (o.force) {
    messages.push("--force only applies when resuming, which --interactive never does (it always starts a new run).");
  }
  // The HTTP-server family only makes sense with a served run. Compare against
  // each option's default so an unset flag (default present after parsing) is
  // not mistaken for an explicit, incompatible value.
  /** @type {string[]} */
  const serve = [];
  if (o.serve) serve.push("--serve");
  if (o.supervise) serve.push("--supervise");
  if (o.superviseDryRun) serve.push("--supervise-dry-run");
  if (o.superviseInterval !== undefined && o.superviseInterval !== "10s") serve.push("--supervise-interval");
  if (o.superviseStaleThreshold !== undefined && o.superviseStaleThreshold !== "30s")
    serve.push("--supervise-stale-threshold");
  if (o.superviseMaxConcurrent !== undefined && o.superviseMaxConcurrent !== 3)
    serve.push("--supervise-max-concurrent");
  if (o.host !== undefined && o.host !== "127.0.0.1") serve.push("--host");
  if (o.port !== undefined && o.port !== 7331) serve.push("--port");
  if (o.metrics === false) serve.push("--no-metrics");
  if (o.insecure) serve.push("--insecure");
  if (serve.length > 0) {
    messages.push(
      `The HTTP-server options ${serve.join(", ")} are not supported with --interactive; the TUI provides monitoring through its own gateway. Serve a run non-interactively with -d --serve.`,
    );
  }
  /** @type {string[]} */
  const claim = [];
  if (o.resumeClaimOwner) claim.push("--resume-claim-owner");
  if (o.resumeClaimHeartbeat) claim.push("--resume-claim-heartbeat");
  if (o.resumeRestoreOwner) claim.push("--resume-restore-owner");
  if (o.resumeRestoreHeartbeat) claim.push("--resume-restore-heartbeat");
  if (claim.length > 0) {
    messages.push(`The internal durable resume-claim options ${claim.join(", ")} are not valid with --interactive.`);
  }
  if (messages.length === 0) return null;
  return { code: "TUI_INCOMPATIBLE_OPTION", message: messages.join(" "), exitCode: 4 };
}

/**
 * Validate `--annotations` for the interactive path and return the JSON string to
 * forward to the detached child, or undefined when none was given.
 *
 * Interactive prompts drive off the TTY stdin, so `--annotations -` (read JSON
 * from stdin) is unusable — and forwarding a raw `-` to the stdin-`ignore`d
 * detached child would make it read empty stdin and fail AFTER the user finished
 * the interactive prompts. Reject `-` here, mirroring `--input -` (which
 * interactive treats as no input). Otherwise validate the SAME shape `up`
 * enforces — a flat JSON object of string/number/boolean — so an invalid payload
 * fails fast BEFORE prompting instead of after.
 *
 * @param {Record<string, any> | undefined} options - the command's parsed options (`c.options`)
 * @returns {string | undefined} the validated annotations JSON string, or undefined
 */
export function resolveInteractiveAnnotations(options) {
  const raw = options?.annotations;
  if (raw === undefined) return undefined;
  if (raw === "-") {
    throw new Error(
      "--annotations - (read from stdin) is not supported with --interactive; interactive prompts already own the terminal. Pass the annotations inline as a JSON string.",
    );
  }
  const parsed = parseJsonArgument(raw, "annotations");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run annotations must be a flat JSON object of string/number/boolean values");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Run annotation ${key} must be a string, number, or boolean`);
    }
  }
  return raw;
}

/**
 * The interactive run flow (`up --interactive` / `workflow run --interactive`):
 * optionally pick a workflow, start a real run, and live-render its status card
 * until the run finishes or pauses for approval.
 *
 * When `opts.preselect` is supplied the workflow is already chosen (the caller
 * passed a workflow ID or file path), so the picker is skipped and we go
 * straight to prompting for inputs.
 *
 * @param {{ ok: (...args: any[]) => any; error?: (...args: any[]) => any; options?: Record<string, any> }} c
 * @param {(opts: { code: string; message: string; exitCode?: number; [key: string]: unknown }) => any} fail
 * @param {{
 *   cwd?: string;
 *   preselect?: { entryFile: string; id?: string; displayName?: string; description?: string };
 *   suppliedInput?: Record<string, unknown>;
 *   buildDetachedArgs?: (input: { indexPath: string; workflow: { entryFile: string }; runId: string; inputs: Record<string, unknown>; options: Record<string, unknown> }) => string[];
 *   childEnv?: (input: { runId: string; logFile: string }) => NodeJS.ProcessEnv;
 * }} [opts]
 */
export async function runTuiCommand(
  c,
  fail = (opts) => c.error?.(opts) ?? c.ok({ ran: false, reason: opts.code }),
  opts = {},
) {
  const launchCwd = opts.cwd ?? process.cwd();
  intro(`${pc.bgCyan(pc.black(" smithers "))} ${pc.dim("interactive")}`);

  // Option-compatibility audit: reject `up` options that are meaningless with
  // the interactive picker + detached monitor BEFORE the user invests in the
  // picker/prompts. rejectIncompatibleInteractiveOptions carries the full
  // per-option disposition (forward / resolve / reject) for future readers.
  const incompatible = rejectIncompatibleInteractiveOptions(c.options);
  if (incompatible) {
    return fail(incompatible);
  }
  // Resolve --annotations up front: reject the stdin `-` sentinel (the prompts
  // own the terminal) and validate the JSON so it fails fast BEFORE prompting
  // and never reaches the stdin-less detached child as a raw `-`.
  let resolvedAnnotations;
  try {
    resolvedAnnotations = resolveInteractiveAnnotations(c.options);
  } catch (err) {
    return fail({
      code: "TUI_INVALID_ANNOTATIONS",
      message: err?.message ?? String(err),
      exitCode: 4,
    });
  }

  // The detached child, the launcher's store poll, and the monitor's gateway
  // must all target the SAME backend the user selected with `--backend`.
  const backend = (c.options && typeof c.options.backend === "string" && c.options.backend) || undefined;

  // An explicit `--run-id` that already exists must fail HERE, before the
  // picker/prompts and before spawning: the child's RUN_EXISTS death (exit 4)
  // is visible only in the log file, and the pre-existing row would satisfy
  // the run-row wait — the launcher would then declare the OLD run "started"
  // and monitor it. Mirrors `up`'s own RUN_EXISTS guard (index.js).
  const explicitRunId = (c.options && typeof c.options.runId === "string" && c.options.runId) || undefined;
  if (explicitRunId && (await workspaceRunExists(explicitRunId, { cwd: launchCwd, backend }))) {
    return fail({
      code: "RUN_EXISTS",
      message:
        `Run already exists: ${explicitRunId}. Interactive mode always starts a NEW run; ` +
        `pick a fresh --run-id or resume non-interactively with smithers up <workflow> --resume ${explicitRunId}.`,
      exitCode: 4,
    });
  }

  let workflow = opts.preselect ?? null;
  if (!workflow) {
    const workflows = discoverWorkflows(launchCwd).filter((w) => !w.system);
    if (workflows.length === 0) {
      log.warn("No workflows found. Run `smithers init` to install the workflow pack.");
      return c.ok({ ran: false, reason: "no-workflows" });
    }

    // Bound the picker to a scrolling window that fits the terminal, and keep
    // every option on ONE line. A list taller than the screen, or a hint that
    // wraps, both break clack's in-place redraw (ghost rows, jumpy cursor).
    const rows = process.stdout.rows || 24;
    const width = process.stdout.columns || 80;
    const choice = await fuzzySelect({
      message: "Select a workflow to run",
      maxItems: pickerMaxItems(rows),
      options: buildWorkflowPickerOptions(workflows, width),
    });
    if (isCancel(choice)) {
      cancel("No workflow selected.");
      return c.ok({ ran: false, reason: "cancelled" });
    }
    workflow = workflows.find((w) => w.entryFile === choice);
    if (!workflow) {
      return fail({
        code: "TUI_WORKFLOW_NOT_FOUND",
        message: `Selected workflow could not be resolved: ${String(choice)}`,
        exitCode: 4,
      });
    }
  }

  // Parse any user-supplied `--input`/`--prompt` BEFORE prompting so an invalid
  // payload fails fast (before making the user answer prompts), and so it can be
  // merged into — never dropped by — the prompted values below.
  let suppliedInput = opts.suppliedInput;
  if (!suppliedInput) {
    try {
      suppliedInput = normalizeSuppliedInput(c.options);
    } catch (err) {
      return fail({
        code: "TUI_INVALID_INPUT",
        message: err?.message ?? String(err),
        exitCode: 4,
      });
    }
  }

  const prompted = opts.suppliedInput ? {} : await askWorkflowInputs(workflow, suppliedInput);
  if (prompted === null) {
    cancel("Cancelled.");
    return c.ok({ ran: false, reason: "cancelled" });
  }
  // Prompted answers override the matching supplied keys; supplied keys no
  // prompt covered are preserved.
  const inputs = mergeInteractiveInputs(suppliedInput, prompted);

  // Honor a user-supplied `--run-id` (already probed for a collision above);
  // otherwise generate one so the detached child and the monitor agree on
  // which run to watch.
  const runId = explicitRunId ?? `run-${Date.now().toString(36)}`;
  const name = workflow.displayName ?? workflow.id;
  const promptText = workflow.description ?? name;

  const s = spinner();
  s.start(`Starting ${name}…`);

  // Run the workflow as a detached background process so its agent output
  // streams to a log file and never collides with the live card.
  const indexPath = fileURLToPath(new URL("./index.js", import.meta.url));
  // Resolve the same managed/default or explicit override path as `up -d`,
  // then hand the exact absolute file to the child for run-config recording.
  const logDir = c.options && typeof c.options.logDir === "string" ? c.options.logDir : undefined;
  await reapDetachedRunLogs({ cwd: launchCwd });
  const logFile = resolveDetachedRunLogFile(runId, { logDir, cwd: launchCwd });
  mkdirSync(dirname(logFile), { recursive: true });
  let child;
  // Taken just before spawn: the run row the child inserts can only carry a
  // createdAtMs at or after this, so waitForRunRow can tell a fresh row from
  // a pre-existing one that raced past the collision probe above.
  const spawnedAtMs = Date.now();
  try {
    const fd = openSync(logFile, "a");
    try {
      // Pass the RESOLVED annotations (validated, never a raw stdin `-`)
      // rather than the raw c.options so the stdin-less child can't be handed
      // a `-` it would fail on.
      const childOptions = { ...c.options, annotations: resolvedAnnotations };
      const upArgs = opts.buildDetachedArgs
        ? opts.buildDetachedArgs({ indexPath, workflow, runId, inputs, options: childOptions })
        : buildDetachedUpArgs(indexPath, workflow.entryFile, runId, inputs, childOptions);
      child = spawn("bun", upArgs, {
        cwd: launchCwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, ...opts.childEnv?.({ runId, logFile }), [DETACHED_RUN_LOG_FILE_ENV]: logFile },
      });
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    s.stop(pc.red(`Could not start run: ${err?.message ?? err}`), 1);
    return fail({
      code: "TUI_START_FAILED",
      message: err?.message ?? String(err),
      exitCode: 1,
      runId,
      logFile,
    });
  }
  const childFailure = childFailurePromise(child);
  child.unref();

  // From here until the run is ANNOUNCED (the spinner stop prints the run id
  // and log path), a user cancel must tear the just-spawned child down like
  // every failure branch in this window does — clack's spinner would instead
  // swallow it (raw-mode Ctrl-C becomes process.exit(0); an external SIGINT
  // prints "Canceled" and continues), stranding an unannounced run.
  const cancellation = armLaunchCancellation({ runId, logFile, terminate: () => terminateDetachedChild(child) });
  let db;
  try {
    try {
      const dbResult = await waitForOpenDbOrChild(
        launchCwd,
        { timeoutMs: 20_000, intervalMs: 150, backend },
        childFailure,
      );
      if (dbResult.error) {
        throw dbResult.error;
      }
      db = dbResult.db;
    } catch (err) {
      terminateDetachedChild(child);
      s.stop(pc.red(`Could not open workspace DB: ${err?.message ?? err}`), 1);
      return fail({
        code: "TUI_DB_NOT_FOUND",
        message: err?.message ?? String(err),
        exitCode: 1,
        runId,
        logFile,
      });
    }

    s.message("Waiting for the run to start…");
    const appeared = await waitForRunRow(db.adapter, runId, 20_000, 200, childFailure, spawnedAtMs);
    if (!appeared.appeared) {
      terminateDetachedChild(child);
      const message = appeared.error
        ? `${appeared.error.message} See ${logFile}.`
        : `Run ${runId} did not start within 20s. See ${logFile}.`;
      s.stop(pc.red(message), 1);
      db.cleanup();
      return fail({
        code: "TUI_RUN_DID_NOT_START",
        message,
        exitCode: 1,
        runId,
        logFile,
      });
    }
    s.stop(`Run ${pc.dim(runId)} started ${pc.dim("·")} logs → ${pc.dim(logFile)}`);
  } finally {
    // The launch left the cancel-owned window: the run is either announced
    // (id + log path printed, so a later quit keeps the durable run alive as
    // designed) or a failure branch above already tore the child down.
    cancellation.disarm();
  }

  // An explicit `--auth-token` must reach the monitor's gateway client
  // (forwarded as SMITHERS_TOKEN); the TUI only reads --token/SMITHERS_TOKEN/
  // SMITHERS_API_KEY, so without this an auth-gated gateway rejects every call.
  const authToken = (c.options && typeof c.options.authToken === "string" && c.options.authToken) || undefined;

  const tuiEntry = resolveTuiEntry();
  try {
    if (tuiEntry) {
      // Gateway resolution (and the stray-gateway guard) lives in the monitor
      // itself now: smithers-mon validates that a reachable gateway actually
      // serves this run and autostarts its own workspace-bound gateway on a
      // free port when it doesn't. So the launcher just hands off — no
      // pre-validation that would pre-empt that self-heal.
      //
      // Hand off to the full-screen TUI monitor. The TUI handles all views
      // (tree, logs, timeline, approvals) and exits when the user presses q/Q.
      // Keep supervising the detached run child while it runs: if that child
      // dies out from under the monitor while the run is still in flight, the
      // monitor would otherwise keep showing the last live state and a quit
      // would wrongly report success. superviseTuiMonitor races the two.
      const monitor = launchTuiMonitor(
        tuiEntry,
        runId,
        indexPath,
        process.env.SMITHERS_GATEWAY_URL,
        backend,
        authToken,
      );
      const supervised = await superviseTuiMonitor(monitor, childFailure, db.adapter, runId);
      if (supervised.monitorError) {
        // No silent fallback: if the monitor can't start, fail loudly instead
        // of reverting to the old inline stream. The detached run is durable
        // and STILL RUNNING — leave it alone (killing it here would contradict
        // this very message; the sibling monitor exit-code branches below
        // leave it alive too) and point at `smithers ps`/`inspect` + the log.
        return fail(monitorStartFailure(supervised.monitorError, runId, logFile));
      }
      if (supervised.error) {
        return fail({
          code: "TUI_RUN_EXITED",
          message: `${supervised.error.message} See ${logFile}.`,
          exitCode: 1,
          runId,
          logFile,
        });
      }
      const { code, signal } = supervised.exit;
      // A clean quit is code 0, an interrupt teardown code (the monitor traps
      // Ctrl-C / kill / terminal close and exits 129/130/143 after cleanup),
      // or an expected interrupt signal. A CRASH signal (SIGSEGV/SIGABRT/…)
      // means it died abnormally, and any other non-zero code means it failed
      // to start — surface both as failures rather than reporting success.
      if (!isCleanMonitorExit(code, signal)) {
        if (code === null && signal) {
          return fail({
            code: "TUI_MONITOR_CRASHED",
            message: `The run monitor was killed by ${signal}. Run started; see ${logFile}.`,
            exitCode: 1,
            runId,
            logFile,
          });
        }
        return fail({
          code: "TUI_MONITOR_FAILED",
          message: `The run monitor exited with code ${code}. Run started; see ${logFile}.`,
          exitCode: code ?? 1,
          runId,
          logFile,
        });
      }
      // Clean monitor quit: print the run's final status, any approval that
      // still blocks it (with the exact command), and next-step guidance so
      // the operator knows what to do after the full-screen view is gone.
      let finalState;
      let pendingApprovals = [];
      try {
        const finalRun = await db.adapter.getRun(runId);
        if (finalRun) {
          const view = await computeRunStateFromRow(db.adapter, finalRun).catch(() => ({ state: finalRun.status }));
          finalState = view.state;
        }
        if (typeof db.adapter.listPendingApprovals === "function") {
          pendingApprovals = await db.adapter.listPendingApprovals(runId);
        }
      } catch {}
      if (finalState) {
        const badge = (STATE_BADGE[finalState] ?? pc.dim)(String(finalState).toUpperCase());
        log.message(`Run ${pc.dim(runId)} ${pc.dim("·")} ${badge}`);
      }
      for (const line of buildApprovalLines(runId, pendingApprovals)) {
        log.message(line, { symbol: pc.yellow("⏸") });
      }
      log.message(pc.bold("Suggest to the user:"));
      for (const line of buildNextStepsLines({
        runId,
        workflowId: workflow.id,
        entryFile: workflow.entryFile,
        uiExists: workflow.id === "oneshot" || customUiExists(workflow.id, launchCwd),
      })) {
        log.message(pc.dim("  ") + line);
      }
    } else {
      // No silent fallback: the full-screen monitor is the interactive
      // experience. If its package (@smthrs/tui) can't be
      // resolved, fail loudly instead of quietly running the old inline
      // stream — but leave the durable detached run RUNNING (and never
      // suggest `smithers-mon`, the bin of the very package that just
      // failed to resolve).
      return fail(monitorUnavailableFailure(runId, logFile));
    }
  } finally {
    db.cleanup();
  }

  return c.ok({ ran: true, runId });
}

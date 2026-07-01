import { intro, log, outro, select, spinner, text, confirm, isCancel, cancel } from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverWorkflows, summarizeWorkflowInputSchema, workflowInputJsonSchema } from "./workflows.js";
import { mdxPlugin } from "./mdx-plugin.js";
import { openSmithersStore } from "smithers-orchestrator/openSmithersStore";
import { parseJsonArgument } from "./json-args.js";
import { parseAgentEvent, parseNodeOutputEvent } from "./chat.js";
import { formatStreamText } from "./tui-format.js";
import { fuzzySelect } from "./fuzzy-select.js";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";

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
        const labelBudget = wantsHint
            ? Math.max(8, Math.min(lineBudget, Math.floor(lineBudget * 0.55)))
            : lineBudget;
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
    return text
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
    "runId", "nodeId", "iteration", "attempt", "run_id", "node_id",
    "createdAtMs", "updatedAtMs", "created_at_ms", "updated_at_ms",
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
    if (!process.stdout.isTTY) return { set() { }, clear() { } };
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
            if (timer) { clearInterval(timer); timer = null; }
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
    return (
        pc.dim(text.slice(0, i)) +
        pc.bgGreen(pc.black(` ${word} `)) +
        pc.dim(text.slice(i + word.length))
    );
}

function shortId(runId) {
    // Run ids are usually short + meaningful (e.g. `run-abc123`); show them
    // whole, only eliding genuinely long ones from the end.
    return runId.length > 24 ? `${runId.slice(0, 21)}…` : runId;
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

    outro(pc.dim(model.footer));
}

/**
 * Read a run from the DB and shape it into a card model.
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} name
 * @param {string} promptText
 * @returns {Promise<RunCardModel | null>}
 */
export async function fetchCard(adapter, runId, name, promptText) {
    const run = await adapter.getRun(runId);
    if (!run) return null;
    const view = await computeRunStateFromRow(adapter, run).catch(() => ({ state: run.status }));
    const nodes = await adapter.listNodes(runId);
    const steps = nodes.map((n) => ({
        label: n.label ?? n.nodeId,
        status: NODE_STATUS[n.state] ?? "pending",
    }));
    return {
        name: run.workflowName ?? name,
        shortId: shortId(runId),
        state: view.state,
        prompt: promptText,
        steps: steps.length ? steps : [{ label: "starting…", status: "pending" }],
        footer: "crash-safe · resumes from the last persisted step",
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
    return Promise.race([
        sleep(ms).then(() => null),
        childFailure.then((error) => ({ error })),
    ]);
}

/**
 * Signals that mean the monitor was asked to stop (or its terminal went away) —
 * a clean user quit, not a failure. Any OTHER terminating signal
 * (SIGSEGV/SIGABRT/SIGKILL/SIGBUS/SIGILL/SIGFPE/SIGQUIT…) means the monitor
 * crashed and must be reported as such, never as success.
 * @type {ReadonlySet<NodeJS.Signals>}
 */
const CLEAN_EXIT_SIGNALS = new Set(
    /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"]),
);

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
            } catch { }
            return waited;
        }
    }
}

/** Poll until the run row exists (the detached run has begun writing). */
export async function waitForRunRow(adapter, runId, timeoutMs, intervalMs, childFailure) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await adapter.getRun(runId)) return { appeared: true };
        const elapsedMs = Date.now() - startedAt;
        const waited = await sleepOrChildFailure(Math.min(intervalMs, Math.max(0, timeoutMs - elapsedMs)), childFailure);
        if (waited?.error) {
            if (await adapter.getRun(runId)) return { appeared: true };
            return { appeared: false, error: waited.error };
        }
    }
    return { appeared: false };
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
    } catch { }
    try {
        child.kill("SIGTERM");
    } catch { }
}

/**
 * Append-only live view of a run: re-renders the status card on every committed
 * frame, and streams agent chat + tool calls in between — each node colored so
 * parallel agents are easy to tell apart. Runs until the run reaches a terminal
 * state, pauses for approval, or the user hits Ctrl-C.
 *
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} name
 * @param {string} promptText
 * @param {{ intervalMs?: number; childFailure?: Promise<Error>; renderCard?: (card: RunCardModel) => void; printLine?: (color: (text: string) => string, label: string, text: string) => void }} [opts]
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
    const onSignal = () => { stopped = true; };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    let lastState;
    let lastRenderedState;
    const renderCurrentCard = async () => {
        const card = await fetchCard(adapter, runId, name, promptText);
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
            for (const ev of events) {
                lastSeq = Number(ev.seq);
                if (ev.type === "FrameCommitted") {
                    await renderCurrentCard();
                    continue;
                }
                if (ev.type === "NodeFinished") {
                    const out = await loadOutputLine(adapter, runId, ev, outputTables);
                    if (out) printLine(colorFor(out.nodeId), labels.get(out.nodeId) ?? displayNode(out.nodeId), out.text);
                    continue;
                }
                const parsed = parseAgentEvent(ev) ?? parseNodeOutputEvent(ev);
                if (parsed?.text && !isCompletedToolPhase(parsed.text)) {
                    const label = labels.get(parsed.nodeId) ?? displayNode(parsed.nodeId);
                    printLine(colorFor(parsed.nodeId), label, parsed.text);
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
 * Load a workflow module and return its declared input fields. Returns [] when
 * the workflow has no input schema or cannot be loaded (so we just run with no
 * input rather than blocking the user).
 * @param {string} entryFile
 * @returns {Promise<{ name: string; type: string; required: boolean; default?: unknown; enum?: unknown[]; description?: string }[]>}
 */
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
 * Prompt for one input field with a clack control matched to its type, re-asking
 * (via clack's validate) until the value is valid. OPTIONAL enum/boolean fields
 * get a "(leave unset)" choice that returns {@link OMIT_FIELD} so absence stays
 * absence instead of being coerced (an optional enum forced to its first member,
 * an optional boolean forced to `false`).
 *
 * @param {{ name: string; type: string; required: boolean; default?: unknown; enum?: unknown[]; description?: string }} field
 * @param {{ select: typeof select; confirm: typeof confirm; text: typeof text }} [prompts] - injectable clack controls (tests)
 * @returns {Promise<unknown | symbol>} coerced value, {@link OMIT_FIELD}, or a clack cancel symbol
 */
export async function promptForField(field, prompts = { select, confirm, text }) {
    const types = String(field.type ?? "").split(" | ");
    const isNumber = types.includes("number") || types.includes("integer");
    const isInteger = types.includes("integer");
    const isBoolean = types.includes("boolean");
    const suffix = field.required ? "" : pc.dim(" (optional)");
    const message = `${field.name}${suffix}${field.description ? ` — ${pc.dim(field.description)}` : ""}`;
    const skipOption = { value: OMIT_FIELD, label: pc.dim("(leave unset)") };

    if (Array.isArray(field.enum) && field.enum.length > 0) {
        const options = field.enum.map((v) => ({ value: v, label: String(v) }));
        // Optional enums must offer an explicit escape hatch; a required enum
        // has none (one of its members must be chosen).
        if (!field.required) options.push(skipOption);
        return prompts.select({ message, options });
    }
    if (isBoolean) {
        // An optional boolean with NO declared default has three outcomes, not
        // two: true, false, or absent. A yes/no confirm can't express "absent"
        // (it forces false), so present a select with a skip choice instead.
        if (!field.required && field.default === undefined) {
            return prompts.select({
                message,
                options: [
                    { value: true, label: "true" },
                    { value: false, label: "false" },
                    skipOption,
                ],
            });
        }
        return prompts.confirm({ message, initialValue: field.default === true });
    }
    const raw = await prompts.text({
        message,
        placeholder: field.default !== undefined ? String(field.default) : undefined,
        validate: (value) => {
            const v = (value ?? "").trim();
            if (!v) {
                if (field.required && field.default === undefined) return "Required.";
                return undefined;
            }
            if (isInteger && !Number.isInteger(Number(v))) return `Enter a whole number for ${field.name}.`;
            if (isNumber && !Number.isFinite(Number(v))) return `Enter a number for ${field.name}.`;
            return undefined;
        },
    });
    if (isCancel(raw)) return raw;
    const v = (raw ?? "").trim();
    if (!v) return field.default;
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
    const raw = typeof o.input === "string" && o.input.length > 0
        ? o.input
        : (o.prompt !== undefined ? JSON.stringify({ prompt: o.prompt }) : undefined);
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
 * @param {{ entryFile: string }} workflow
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function askWorkflowInputs(workflow) {
    const fields = await loadWorkflowInputFields(workflow.entryFile);
    if (fields.length === 0) return {};
    log.message(pc.dim(`This workflow takes ${fields.length} input${fields.length === 1 ? "" : "s"}.`));
    const inputs = {};
    for (const field of fields) {
        const value = await promptForField(field);
        if (isCancel(value)) return null;
        // Skip blank optional text (undefined) and explicitly-skipped optional
        // enum/boolean (OMIT_FIELD) so absent input stays absent.
        if (includeFieldValue(value)) inputs[field.name] = value;
    }
    return inputs;
}

/**
 * Resolve the full-screen TUI monitor entry point through the installed
 * `@smithers-orchestrator/tui` package (its `smithers-mon` bin), so it works for
 * published installs — not just from a relative path inside this monorepo.
 * Returns null when the package can't be resolved (e.g. it wasn't installed),
 * letting the caller fall back to the inline stream loop.
 * @returns {string | null}
 */
export function resolveTuiEntry() {
    try {
        const pkgUrl = import.meta.resolve("@smithers-orchestrator/tui/package.json");
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
 * @param {NodeJS.ProcessEnv} baseEnv - env to extend (usually `process.env`)
 * @param {{ cliIndexPath: string; gatewayUrl?: string; backend?: string; authToken?: string }} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function buildTuiMonitorEnv(baseEnv, { cliIndexPath, gatewayUrl, backend, authToken }) {
    const env = { ...baseEnv, SMITHERS_CLI: cliIndexPath };
    if (gatewayUrl) env.SMITHERS_GATEWAY_URL = gatewayUrl;
    if (backend) env.SMITHERS_BACKEND = backend;
    if (authToken) env.SMITHERS_TOKEN = authToken;
    return env;
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
    const env = buildTuiMonitorEnv(process.env, { cliIndexPath, gatewayUrl, backend, authToken });
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
            } catch { }
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
 * unhandled rejections; the losing branch is simply abandoned.
 *
 * @param {{ exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; terminate: () => void }} monitor
 * @param {Promise<Error>} childFailure
 * @param {{ getRun: (runId: string) => Promise<unknown> }} adapter
 * @param {string} runId
 * @returns {Promise<{ exit?: { code: number | null; signal: NodeJS.Signals | null }; error?: Error }>}
 */
export async function superviseTuiMonitor(monitor, childFailure, adapter, runId) {
    const outcome = await Promise.race([
        monitor.exit.then((exit) => ({ kind: "exit", exit })),
        childFailure.then((error) => ({ kind: "child", error })),
    ]);
    if (outcome.kind === "exit") {
        return { exit: outcome.exit };
    }
    // The detached run child exited while the monitor was up. Re-read the run
    // state to tell a legitimate end from a premature death.
    const run = await adapter.getRun(runId).catch(() => null);
    let state;
    if (run) {
        const view = await computeRunStateFromRow(adapter, run).catch(() => ({ state: run.status }));
        state = view.state;
    }
    if (state && STOP_STATES.has(state)) {
        // Run legitimately reached a stop state; keep the monitor up until the
        // user quits, then hand its exit back to the caller unchanged.
        return { exit: await monitor.exit };
    }
    // Child died with the run still in flight — tear the monitor down and fail.
    monitor.terminate();
    return { error: outcome.error };
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
    const pinned = typeof env.SMITHERS_GATEWAY_URL === "string" && env.SMITHERS_GATEWAY_URL.length > 0
        ? env.SMITHERS_GATEWAY_URL.replace(/\/+$/, "")
        : undefined;
    if (pinned) return pinned;
    const port = parseMonitorGatewayPort(env.SMITHERS_GATEWAY_PORT);
    return `http://127.0.0.1:${port}`;
}

/**
 * Parse SMITHERS_GATEWAY_PORT for the parent-side monitor check, mirroring the
 * TUI's own validation (@smithers-orchestrator/tui `isValidGatewayPort`): a legal
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
 * Whether a Gateway answers its `/health` probe at `base` (i.e. one is already
 * listening there and the monitor would REUSE it rather than autostart its own).
 * @param {string} base
 * @param {string} [token]
 */
async function gatewayHealthy(base, token) {
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    return fetch(`${base}/health`, { headers }).then((r) => r.ok, () => false);
}

/**
 * Fetch a run from a Gateway over its HTTP RPC (same wire shape as `smithers ui`).
 * Returns the run payload, `null` when the gateway does not serve it, and THROWS
 * on transport/protocol/auth errors so the caller can keep polling through a
 * transient blip instead of treating one as a definitive miss.
 * @param {string} base - gateway base URL
 * @param {string} runId
 * @param {string} [token] - bearer when the gateway requires auth
 * @returns {Promise<unknown | null>}
 */
async function gatewayGetRun(base, runId, token) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/v1/rpc/getRun`, {
        method: "POST",
        headers,
        body: JSON.stringify({ runId }),
    });
    const frame = await res.json().catch(() => null);
    if (!frame || frame.type !== "res") throw new Error(`Gateway at ${base} returned an invalid RPC frame for getRun.`);
    if (!frame.ok) throw new Error(frame.error?.message ?? "Gateway RPC getRun failed.");
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
 * instead. Transport errors (a momentary blip) are swallowed and retried until
 * the timeout so a truly-serving gateway that is briefly slow still passes.
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
        } catch {
            // Transient gateway/RPC/auth blip while it settles; keep polling until
            // the timeout rather than failing on the first miss.
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
    if (o.annotations) args.push("--annotations", String(o.annotations));
    if (o.backend) args.push("--backend", String(o.backend));
    return args;
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
 * @param {{ preselect?: { entryFile: string; id?: string; displayName?: string; description?: string } }} [opts]
 */
export async function runTuiCommand(c, fail = (opts) => c.error?.(opts) ?? c.ok({ ran: false, reason: opts.code }), opts = {}) {
    intro(`${pc.bgCyan(pc.black(" smithers "))} ${pc.dim("interactive")}`);

    let workflow = opts.preselect ?? null;
    if (!workflow) {
        const workflows = discoverWorkflows();
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
    let suppliedInput;
    try {
        suppliedInput = normalizeSuppliedInput(c.options);
    } catch (err) {
        return fail({
            code: "TUI_INVALID_INPUT",
            message: err?.message ?? String(err),
            exitCode: 4,
        });
    }

    const prompted = await askWorkflowInputs(workflow);
    if (prompted === null) {
        cancel("Cancelled.");
        return c.ok({ ran: false, reason: "cancelled" });
    }
    // Prompted answers override the matching supplied keys; supplied keys no
    // prompt covered are preserved.
    const inputs = mergeInteractiveInputs(suppliedInput, prompted);

    // The detached child, the launcher's store poll, and the monitor's gateway
    // must all target the SAME backend the user selected with `--backend`.
    const backend = (c.options && typeof c.options.backend === "string" && c.options.backend) || undefined;

    // Honor a user-supplied `--run-id`; otherwise generate one so the detached
    // child and the monitor agree on which run to watch.
    const runId = (c.options && typeof c.options.runId === "string" && c.options.runId) || `run-${Date.now().toString(36)}`;
    const name = workflow.displayName ?? workflow.id;
    const promptText = workflow.description ?? name;

    const s = spinner();
    s.start(`Starting ${name}…`);

    // Run the workflow as a detached background process so its agent output
    // streams to a log file and never collides with the live card.
    const indexPath = fileURLToPath(new URL("./index.js", import.meta.url));
    // Honor --log-dir the same way `up` does (index.js resolves the child's log
    // file from `options.logDir ?? dirname(resolvedWorkflowPath)`, and
    // buildDetachedUpArgs forwards --log-dir to the child), so the launcher's
    // "logs → …" path points at the SAME file the run writes to.
    const logDir = (c.options && typeof c.options.logDir === "string" && c.options.logDir) || dirname(workflow.entryFile);
    const logFile = resolve(logDir, `${runId}.log`);
    let child;
    try {
        const fd = openSync(logFile, "a");
        try {
            const upArgs = buildDetachedUpArgs(indexPath, workflow.entryFile, runId, inputs, c.options);
            child = spawn("bun", upArgs, {
                detached: true,
                stdio: ["ignore", fd, fd],
                env: process.env,
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

    let db;
    try {
        const dbResult = await waitForOpenDbOrChild(process.cwd(), { timeoutMs: 20_000, intervalMs: 150, backend }, childFailure);
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
    const appeared = await waitForRunRow(db.adapter, runId, 20_000, 200, childFailure);
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

    // An explicit `--auth-token` must reach the monitor's gateway client
    // (forwarded as SMITHERS_TOKEN); the TUI only reads --token/SMITHERS_TOKEN/
    // SMITHERS_API_KEY, so without this an auth-gated gateway rejects every call.
    const authToken = (c.options && typeof c.options.authToken === "string" && c.options.authToken) || undefined;

    const tuiEntry = resolveTuiEntry();
    try {
        if (tuiEntry) {
            // Guard against a stray REUSED gateway on a different backend/workspace.
            // The monitor reuses any healthy gateway at the default address before
            // autostarting its own; if that one serves a different store, the
            // detached run writes here while the monitor reads there — a silently
            // empty monitor. Only a REUSED (already-listening) gateway can mismatch;
            // an autostarted one inherits the forwarded backend, so we validate only
            // when a gateway is already up.
            const monitorBase = resolveMonitorGatewayBase(process.env);
            const monitorToken = resolveMonitorToken(authToken, process.env);
            if (await gatewayHealthy(monitorBase, monitorToken)) {
                const check = await validateGatewayServesRun(
                    (id) => gatewayGetRun(monitorBase, id, monitorToken),
                    runId,
                    monitorBase,
                    { timeoutMs: 10_000, intervalMs: 250 },
                );
                if (!check.ok) {
                    terminateDetachedChild(child);
                    return fail({
                        code: "TUI_GATEWAY_RUN_MISMATCH",
                        message: `${check.message} See ${logFile}.`,
                        exitCode: 1,
                        runId,
                        logFile,
                    });
                }
            }
            // Hand off to the full-screen TUI monitor. The TUI handles all views
            // (tree, logs, timeline, approvals) and exits when the user presses q/Q.
            // Keep supervising the detached run child while it runs: if that child
            // dies out from under the monitor while the run is still in flight, the
            // monitor would otherwise keep showing the last live state and a quit
            // would wrongly report success. superviseTuiMonitor races the two.
            const monitor = launchTuiMonitor(tuiEntry, runId, indexPath, process.env.SMITHERS_GATEWAY_URL, backend, authToken);
            const supervised = await superviseTuiMonitor(monitor, childFailure, db.adapter, runId);
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
                        message: `The run monitor was killed by ${signal}. Run started — see ${logFile}.`,
                        exitCode: 1,
                        runId,
                        logFile,
                    });
                }
                return fail({
                    code: "TUI_MONITOR_FAILED",
                    message: `The run monitor exited with code ${code}. Run started — see ${logFile}.`,
                    exitCode: code ?? 1,
                    runId,
                    logFile,
                });
            }
        } else {
            // The TUI package isn't available (e.g. a slim install) — fall back to
            // the inline append-only stream loop so the run is still observable.
            // streamRun returns `{ error }` when the detached process dies before the
            // run reaches a terminal/pause state; surface that as a failure instead of
            // reporting success, mirroring the old inline path's TUI_RUN_EXITED.
            const result = await streamRun(db.adapter, runId, name, promptText, { childFailure });
            if (result.error) {
                return fail({
                    code: "TUI_RUN_EXITED",
                    message: `${result.error.message} See ${logFile}.`,
                    exitCode: 1,
                    runId,
                    logFile,
                });
            }
        }
    } finally {
        db.cleanup();
    }

    return c.ok({ ran: true, runId });
}

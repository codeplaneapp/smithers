import { intro, log, outro, select, spinner, text, confirm, isCancel, cancel } from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverWorkflows, summarizeWorkflowInputSchema, workflowInputJsonSchema } from "./workflows.js";
import { mdxPlugin } from "./mdx-plugin.js";
import { findSmithersDb, openSmithersDb } from "./find-db.js";
import { parseAgentEvent, parseNodeOutputEvent } from "./chat.js";
import { handleApprovals, handleHumanRequests } from "./tui-gates.js";
import { formatStreamText } from "./tui-format.js";
import { fuzzySelect } from "./fuzzy-select.js";
import { renderRunOutputs } from "./pretty.js";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";

export { formatStreamText } from "./tui-format.js";

/**
 * @typedef {object} RunCardStep
 * @property {string} label
 * @property {"persisted" | "running" | "waiting" | "failed" | "pending"} status
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
    cancelled: "failed",
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
 * @param {string} from
 * @param {{ timeoutMs?: number; intervalMs?: number }} opts
 * @param {Promise<Error>} childFailure
 * @returns {Promise<{ db?: Awaited<ReturnType<typeof openSmithersDb>> & { dbPath: string }; error?: Error }>}
 */
async function waitForOpenDbOrChild(from, opts, childFailure) {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
    const intervalMs = Math.max(1, opts.intervalMs ?? 100);
    const startedAt = Date.now();
    let lastMissing;

    while (true) {
        try {
            const dbPath = findSmithersDb(from);
            const db = await openSmithersDb(dbPath);
            return { db: { ...db, dbPath } };
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
                const dbPath = findSmithersDb(from);
                const db = await openSmithersDb(dbPath);
                return { db: { ...db, dbPath } };
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
 * Spawn `smithers up` for a run as a detached, log-redirected process. Used for
 * the initial launch and to resume the run after a gate is resolved.
 * @param {{ indexPath: string; entryFile: string; runId: string; inputs?: Record<string, unknown>; resume?: boolean }} opts
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnUpProcess({ indexPath, entryFile, runId, inputs, resume }) {
    const logFile = resolve(dirname(entryFile), `${runId}.log`);
    const args = [indexPath, "up", entryFile, "--run-id", runId];
    if (resume) args.push("--resume");
    if (inputs && Object.keys(inputs).length > 0) args.push("--input", JSON.stringify(inputs));
    const fd = openSync(logFile, "a");
    try {
        return spawn("bun", args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    } finally {
        closeSync(fd);
    }
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
                if (parsed?.text) {
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
async function loadWorkflowInputFields(entryFile) {
    // Loading a workflow constructs its agents, which can log init warnings;
    // silence both streams so discovery cannot corrupt the interactive prompt.
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
        mdxPlugin();
        const mod = await import(pathToFileURL(resolve(process.cwd(), entryFile)).href);
        const summary = summarizeWorkflowInputSchema(workflowInputJsonSchema(mod.default?.inputSchema));
        return summary?.fields ?? [];
    } catch {
        return [];
    } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
    }
}

/**
 * Prompt for one input field with a clack control matched to its type, re-asking
 * (via clack's validate) until the value is valid.
 * @param {{ name: string; type: string; required: boolean; default?: unknown; enum?: unknown[]; description?: string }} field
 * @returns {Promise<unknown | symbol>} coerced value, or a clack cancel symbol
 */
export async function promptForField(field) {
    const types = String(field.type ?? "").split(" | ");
    const isNumber = types.includes("number") || types.includes("integer");
    const isInteger = types.includes("integer");
    const isBoolean = types.includes("boolean");
    const suffix = field.required ? "" : pc.dim(" (optional)");
    const message = `${field.name}${suffix}${field.description ? ` — ${pc.dim(field.description)}` : ""}`;

    if (Array.isArray(field.enum) && field.enum.length > 0) {
        return select({ message, options: field.enum.map((v) => ({ value: v, label: String(v) })) });
    }
    if (isBoolean) {
        return confirm({ message, initialValue: field.default === true });
    }
    const raw = await text({
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
        if (value !== undefined) inputs[field.name] = value;
    }
    return inputs;
}

/**
 * `smithers tui` — pick a workflow, start a real run, and live-render its
 * status card until the run finishes or pauses for approval.
 * @param {{ ok: (...args: any[]) => any; error?: (...args: any[]) => any }} c
 * @param {(opts: { code: string; message: string; exitCode?: number; [key: string]: unknown }) => any} fail
 */
export async function runTuiCommand(c, fail = (opts) => c.error?.(opts) ?? c.ok({ ran: false, reason: opts.code })) {
    intro(`${pc.bgCyan(pc.black(" smithers "))} ${pc.dim("tui")}`);

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
    const workflow = workflows.find((w) => w.entryFile === choice);
    if (!workflow) {
        return fail({
            code: "TUI_WORKFLOW_NOT_FOUND",
            message: `Selected workflow could not be resolved: ${String(choice)}`,
            exitCode: 4,
        });
    }

    const inputs = await askWorkflowInputs(workflow);
    if (inputs === null) {
        cancel("Cancelled.");
        return c.ok({ ran: false, reason: "cancelled" });
    }

    const runId = `run-${Date.now().toString(36)}`;
    const name = workflow.displayName ?? workflow.id;
    const promptText = workflow.description ?? name;

    const s = spinner();
    s.start(`Starting ${name}…`);

    // Run the workflow as a detached background process so its agent output
    // streams to a log file and never collides with the live card.
    const indexPath = fileURLToPath(new URL("./index.js", import.meta.url));
    const logFile = resolve(dirname(workflow.entryFile), `${runId}.log`);
    let child;
    try {
        const fd = openSync(logFile, "a");
        try {
            const upArgs = [indexPath, "up", workflow.entryFile, "--run-id", runId];
            if (inputs && Object.keys(inputs).length > 0) {
                upArgs.push("--input", JSON.stringify(inputs));
            }
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
        const dbResult = await waitForOpenDbOrChild(process.cwd(), { timeoutMs: 20_000, intervalMs: 150 }, childFailure);
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
    s.stop(`Watching ${pc.dim(runId)} ${pc.dim("·")} logs → ${pc.dim(logFile)}`);

    try {
        let result = await streamRun(db.adapter, runId, name, promptText, { childFailure });
        let finalState = result.state;
        // The detached `up` process exits whenever the run pauses for a gate
        // (approval or human input). Resolve the gate via clack, resume the run
        // as a fresh process, and keep streaming. Repeat until the run finishes.
        while (true) {
            const approvals = await db.adapter.listPendingApprovals(runId);
            const humans = (await db.adapter.listPendingHumanRequests()).filter((r) => r.runId === runId);
            if (approvals.length === 0 && humans.length === 0) {
                if (result.error) {
                    const message = `${result.error.message} See ${logFile}.`;
                    return fail({ code: "TUI_RUN_EXITED", message, exitCode: 1, runId, logFile });
                }
                break;
            }

            const gate = humans.length > 0
                ? await handleHumanRequests(db.adapter, runId)
                : await handleApprovals(db.adapter, runId);
            if (gate.cancelled) {
                return c.ok({ ran: true, runId, paused: true });
            }

            const runRow = await db.adapter.getRun(runId);
            const view = runRow
                ? await computeRunStateFromRow(db.adapter, runRow).catch(() => ({ state: runRow.status }))
                : { state: undefined };
            finalState = view.state ?? finalState;
            if (["succeeded", "failed", "cancelled"].includes(view.state)) break;

            const resumeChild = spawnUpProcess({ indexPath, entryFile: workflow.entryFile, runId, inputs, resume: true });
            const resumeFailure = childFailurePromise(resumeChild);
            resumeChild.unref();
            result = await streamRun(db.adapter, runId, name, promptText, { childFailure: resumeFailure });
            finalState = result.state ?? finalState;
        }
        if (["succeeded", "failed", "cancelled"].includes(String(finalState))) {
            log.message(pc.bold("Outputs"));
            await renderRunOutputs(db.adapter, runId);
        }
    } finally {
        db.cleanup();
    }

    return c.ok({ ran: true, runId });
}

import { Effect } from "effect";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { approveNode, denyNode } from "@smithers-orchestrator/engine/approvals";
import { isHumanRequestPastTimeout, validateHumanRequestValue } from "@smithers-orchestrator/engine/human-requests";
import { deriveTailStatus, formatTailFinalStatusLine, isTailActiveState, lingerUntilClosed } from "./tail.js";

/**
 * Interactive `smithers approve --watch <run>` loop. Runs inside a herdr gate
 * pane (or any terminal): polls the run's pending approval gates AND pending
 * human requests, renders each with its question/options, reads a single-key (or
 * short line) answer in raw mode, commits it through the SAME engine machinery the
 * non-interactive `approve` / `deny` / `human answer` commands use, then keeps
 * watching for the next block. When the run reaches a terminal state it prints the
 * final status line and lingers (reusing tail's `lingerUntilClosed`) so the pane
 * does not vanish. Every DB interaction is read-or-commit against the real store —
 * no mocks, no fabricated state.
 */

/** Poll cadence for the watch loop while nothing is actionable. Human-in-the-loop, so a touch slower than tail's 500ms. */
export const APPROVE_WATCH_POLL_INTERVAL_MS = 1000;

/** The raw ETX byte Ctrl-C sends on a raw-mode TTY stdin (no SIGINT fires there). */
const CTRL_C_CHAR = String.fromCharCode(3);
/** DEL and BS, either of which a terminal may send for the Backspace key. */
const DEL_CHAR = String.fromCharCode(127);
const BS_CHAR = "\b";

/**
 * Returned by a key/line read (and propagated up the prompt helpers) when the
 * operator asked to quit: Ctrl-C (raw ETX 0x03, which fires no SIGINT in raw
 * mode), a `q`/`Q` keypress at an approval prompt, or a delivered SIGINT/SIGTERM.
 * A unique symbol so it can never collide with a real keystroke string.
 * @type {unique symbol}
 */
export const CANCEL = Symbol("approve-watch-cancel");

/**
 * Outcome returned when an approve/deny/answer was attempted but the engine
 * commit threw. The gate is still pending, so the watch loop must NOT auto-resume
 * the run (nothing was decided) and simply re-polls to re-prompt.
 */
const COMMIT_FAILED = "commit-failed";

/** Human-request kinds the watch loop answers interactively. `json` accepts a raw JSON line. */
const INTERACTIVE_HUMAN_KINDS = new Set(["ask", "confirm", "select", "json"]);

/**
 * @param {string} nodeId
 * @param {number | null | undefined} iteration
 * @returns {string}
 */
function targetKey(nodeId, iteration) {
  // NUL separator so a nodeId containing digits can never collide with another
  // (nodeId, iteration) pair.
  return `${nodeId}\u0000${iteration ?? 0}`;
}

/**
 * A raw-mode-aware reader over a stdin stream that yields either a single
 * keypress ({@link nextKey}) or an accumulated line ({@link nextLine}). Buffers
 * input so a chunk carrying several bytes (a paste, or a test writing a whole
 * string) is consumed one unit at a time. In a TTY it enables raw mode (so single
 * keys arrive without Enter and it can catch the raw Ctrl-C byte) and echoes typed
 * characters itself (the terminal does not echo in raw mode); a non-TTY stream (a
 * pipe, or a test PassThrough) is read as-is with no echo. A ref'd keepalive timer
 * holds the event loop open. SIGINT/SIGTERM and a raw Ctrl-C (0x03) resolve any
 * pending read — and every later read — with {@link CANCEL}.
 *
 * @param {NodeJS.ReadStream | import("node:stream").Readable} stdin
 * @param {(text: string) => void} emit
 * @returns {{ nextKey: () => Promise<string | typeof CANCEL>, nextLine: () => Promise<string | typeof CANCEL>, drain: () => void, cancelled: () => boolean, waitCancel: () => Promise<void>, close: () => void }}
 */
export function createKeyReader(stdin, emit) {
  let rawSet = false;
  let closed = false;
  let cancelled = false;
  /** @type {string} */
  let buffer = "";
  /** @type {null | { resolve: (value: string | typeof CANCEL) => void, mode: "key" | "line", line: string }} */
  let waiter = null;
  /** @type {(() => void) | null} */
  let resolveCancel = null;
  const cancelPromise = new Promise((resolve) => {
    resolveCancel = resolve;
  });

  // A ref'd no-op interval holds the event loop open until a key/line/signal
  // arrives, independent of stdin being a TTY, a pipe, or an already-EOF stream.
  const keepAlive = setInterval(() => {}, 1 << 30);

  try {
    if (/** @type {any} */ (stdin).isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      rawSet = true;
    }
  } catch {
    // stdin is not a TTY / cannot enter raw mode: read it cooked.
  }
  if (typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }
  if (typeof stdin.resume === "function") {
    stdin.resume();
  }

  function triggerCancel() {
    if (cancelled) {
      return;
    }
    cancelled = true;
    resolveCancel?.();
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(CANCEL);
    }
  }

  /** Feed buffered input into the active waiter, if any. */
  function pump() {
    if (!waiter) {
      return;
    }
    if (waiter.mode === "key") {
      if (buffer.length === 0) {
        return;
      }
      const ch = buffer[0];
      buffer = buffer.slice(1);
      if (ch === CTRL_C_CHAR) {
        // Raw Ctrl-C (no SIGINT in raw mode): treat as quit.
        triggerCancel();
        return;
      }
      const w = waiter;
      waiter = null;
      w.resolve(ch);
      return;
    }
    // line mode: accumulate until CR/LF, echoing in raw mode so the operator
    // sees what they type (the terminal does not echo with ISIG/ICANON off).
    while (buffer.length > 0) {
      const ch = buffer[0];
      buffer = buffer.slice(1);
      if (ch === "\r" || ch === "\n") {
        const w = waiter;
        waiter = null;
        if (rawSet) {
          emit("\n");
        }
        w.resolve(w.line);
        return;
      }
      if (ch === CTRL_C_CHAR) {
        triggerCancel();
        return;
      }
      if (ch === DEL_CHAR || ch === BS_CHAR) {
        if (waiter.line.length > 0) {
          waiter.line = waiter.line.slice(0, -1);
          if (rawSet) {
            emit("\b \b");
          }
        }
        continue;
      }
      waiter.line += ch;
      if (rawSet) {
        emit(ch);
      }
    }
  }

  /** @param {Buffer | string} chunk */
  function onData(chunk) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    pump();
  }
  const onSignal = () => triggerCancel();

  stdin.on("data", onData);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    nextKey() {
      return new Promise((resolve) => {
        if (cancelled) {
          resolve(CANCEL);
          return;
        }
        waiter = { resolve, mode: "key", line: "" };
        pump();
      });
    },
    nextLine() {
      return new Promise((resolve) => {
        if (cancelled) {
          resolve(CANCEL);
          return;
        }
        waiter = { resolve, mode: "line", line: "" };
        pump();
      });
    },
    // Discard buffered-but-unconsumed input, so a stray keypress during the
    // idle poll window cannot pre-answer the NEXT gate that appears.
    drain() {
      buffer = "";
    },
    cancelled() {
      return cancelled;
    },
    waitCancel() {
      return cancelPromise;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(keepAlive);
      if (typeof stdin.off === "function") {
        stdin.off("data", onData);
      }
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (rawSet && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(false);
        } catch {
          // no longer a TTY: nothing to restore
        }
      }
      if (typeof stdin.pause === "function") {
        try {
          stdin.pause();
        } catch {
          // best-effort
        }
      }
    },
  };
}

/**
 * @param {string | null | undefined} requestJson
 * @returns {{ title?: string, summary?: string }}
 */
function parseApprovalRequest(requestJson) {
  if (typeof requestJson !== "string" || requestJson === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(requestJson);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // ignore malformed request json
  }
  return {};
}

/**
 * Render the block shown when a run parks on an approval gate.
 *
 * @param {string} runId
 * @param {{ nodeId: string, iteration?: number | null, requestJson?: string | null }} approval
 * @returns {string}
 */
export function renderApprovalPrompt(runId, approval) {
  const request = parseApprovalRequest(approval.requestJson);
  const iteration = approval.iteration ?? 0;
  const lines = [
    "",
    "────────────────────────────────────────",
    `⏸ approval needed · ${approval.nodeId} (iteration ${iteration})`,
  ];
  if (typeof request.title === "string" && request.title !== "") {
    lines.push(request.title);
  }
  if (typeof request.summary === "string" && request.summary !== "" && request.summary !== request.title) {
    lines.push(request.summary);
  }
  lines.push(`(equivalent: smithers approve ${runId} --node ${approval.nodeId} --iteration ${iteration})`);
  lines.push("[y] approve   [n] deny   [q] quit");
  return `${lines.join("\n")}\n`;
}

/**
 * Parse a select request's stored options into `{ label, value }` pairs. Options
 * are typically strings (from `smithers ask-human --choices`), but an object
 * option ({ label, value } / { label }) is tolerated.
 *
 * @param {string | null | undefined} optionsJson
 * @returns {Array<{ label: string, value: unknown }>}
 */
export function parseSelectOptions(optionsJson) {
  if (typeof optionsJson !== "string" || optionsJson === "") {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((opt) => {
    if (opt && typeof opt === "object") {
      const label = typeof opt.label === "string" ? opt.label : JSON.stringify(opt);
      const value = "value" in opt ? opt.value : opt;
      return { label, value };
    }
    return { label: String(opt), value: opt };
  });
}

/**
 * Render the block shown when a run parks on a human request.
 *
 * @param {{ nodeId: string, iteration?: number | null, kind: string, prompt?: string | null, optionsJson?: string | null }} request
 * @param {Array<{ label: string, value: unknown }>} options
 * @returns {string}
 */
export function renderHumanRequestPrompt(request, options) {
  const iteration = request.iteration ?? 0;
  const lines = [
    "",
    "────────────────────────────────────────",
    `⏸ human request (${request.kind}) · ${request.nodeId} (iteration ${iteration})`,
  ];
  if (typeof request.prompt === "string" && request.prompt !== "") {
    lines.push(request.prompt);
  }
  if (request.kind === "select" && options.length > 0) {
    for (let i = 0; i < options.length; i += 1) {
      lines.push(`  [${i + 1}] ${options[i].label}`);
    }
    lines.push(options.length <= 9 ? "Press a digit to choose (q to quit)." : "Type a number then Enter (q to quit).");
  } else if (request.kind === "confirm") {
    lines.push("[y] yes   [n] no   [q] quit");
  } else if (request.kind === "json") {
    lines.push("Type a JSON value then Enter (q to quit).");
  } else {
    lines.push("Type your answer then Enter (q to quit).");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * List the next actionable block for a run: its pending approval gates and
 * pending human requests, optionally filtered to a single node. Human requests
 * win for a node that has one (a HumanTask parks on an approval AND a request; the
 * human-answer path resolves both, so treating it as a bare approval would leave
 * the request pending). Approvals shadowed by a human request are dropped; the
 * remaining candidates are ordered oldest-first.
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {string | undefined} nodeFilter
 * @returns {Promise<{ kind: "approval" | "human", at: number, item: any } | null>}
 */
export async function findNextPending(adapter, runId, nodeFilter) {
  const humanRows = (await adapter.listPendingHumanRequests()).filter(
    (r) => r && r.runId === runId && (!nodeFilter || r.nodeId === nodeFilter),
  );
  const approvals = (await adapter.listPendingApprovals(runId)).filter(
    (a) => a && (!nodeFilter || a.nodeId === nodeFilter),
  );
  const humanKeys = new Set(humanRows.map((r) => targetKey(r.nodeId, r.iteration)));
  /** @type {Array<{ kind: "approval" | "human", at: number, item: any }>} */
  const candidates = [];
  for (const r of humanRows) {
    if (!INTERACTIVE_HUMAN_KINDS.has(r.kind)) {
      continue;
    }
    candidates.push({ kind: "human", at: typeof r.requestedAtMs === "number" ? r.requestedAtMs : 0, item: r });
  }
  for (const a of approvals) {
    if (humanKeys.has(targetKey(a.nodeId, a.iteration))) {
      continue;
    }
    candidates.push({ kind: "approval", at: typeof a.requestedAtMs === "number" ? a.requestedAtMs : 0, item: a });
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((x, y) => x.at - y.at);
  return candidates[0];
}

/**
 * Prompt for and commit a decision on one pending approval gate. Loops on an
 * unrecognized key. Returns {@link CANCEL} if the operator quit, else a short
 * outcome string (the loop re-polls on any return).
 *
 * @param {{ runId: string, nodeId: string, iteration?: number | null, requestJson?: string | null }} approval
 * @param {{ adapter: any, reader: ReturnType<typeof createKeyReader>, emit: (t: string) => void, decidedBy?: string }} ctx
 * @returns {Promise<string | typeof CANCEL>}
 */
async function resolveApproval(approval, ctx) {
  const { adapter, reader, emit, decidedBy } = ctx;
  const iteration = approval.iteration ?? 0;
  reader.drain();
  emit(renderApprovalPrompt(approval.runId ?? "", approval));
  for (;;) {
    const key = await reader.nextKey();
    if (key === CANCEL || key === "q" || key === "Q") {
      return CANCEL;
    }
    if (key === "y" || key === "Y" || key === "\r" || key === "\n") {
      try {
        await Effect.runPromise(approveNode(adapter, approval.runId, approval.nodeId, iteration, undefined, decidedBy));
        emit(`✓ approved ${approval.nodeId}\n`);
      } catch (err) {
        emit(`✗ could not approve ${approval.nodeId}: ${err?.message ?? String(err)}\n`);
        return COMMIT_FAILED;
      }
      return "approved";
    }
    if (key === "n" || key === "N") {
      emit("Deny note (optional, Enter to skip): ");
      const note = await reader.nextLine();
      if (note === CANCEL) {
        return CANCEL;
      }
      const trimmed = typeof note === "string" ? note.trim() : "";
      try {
        await Effect.runPromise(
          denyNode(adapter, approval.runId, approval.nodeId, iteration, trimmed || undefined, decidedBy),
        );
        emit(`✗ denied ${approval.nodeId}\n`);
      } catch (err) {
        emit(`✗ could not deny ${approval.nodeId}: ${err?.message ?? String(err)}\n`);
        return COMMIT_FAILED;
      }
      return "denied";
    }
    emit("Press y to approve, n to deny, or q to quit.\n");
  }
}

/**
 * Read the answer VALUE for a human request of the given kind. Loops until a
 * valid value or {@link CANCEL}.
 *
 * @param {{ kind: string }} request
 * @param {Array<{ label: string, value: unknown }>} options
 * @param {{ reader: ReturnType<typeof createKeyReader>, emit: (t: string) => void }} ctx
 * @returns {Promise<{ value: unknown } | typeof CANCEL>}
 */
async function readHumanValue(request, options, ctx) {
  const { reader, emit } = ctx;
  if (request.kind === "confirm") {
    for (;;) {
      const key = await reader.nextKey();
      if (key === CANCEL || key === "q" || key === "Q") {
        return CANCEL;
      }
      if (key === "y" || key === "Y") {
        return { value: true };
      }
      if (key === "n" || key === "N") {
        return { value: false };
      }
      emit("Press y for yes, n for no, or q to quit.\n");
    }
  }
  if (request.kind === "select") {
    const compact = options.length > 0 && options.length <= 9;
    for (;;) {
      if (compact) {
        const key = await reader.nextKey();
        if (key === CANCEL || key === "q" || key === "Q") {
          return CANCEL;
        }
        const index = typeof key === "string" && /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
        if (index >= 0 && index < options.length) {
          return { value: options[index].value };
        }
        emit(`Press a digit 1-${options.length}, or q to quit.\n`);
        continue;
      }
      const line = await reader.nextLine();
      if (line === CANCEL) {
        return CANCEL;
      }
      const trimmed = typeof line === "string" ? line.trim() : "";
      if (trimmed === "q" || trimmed === "Q") {
        return CANCEL;
      }
      const index = Number.parseInt(trimmed, 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) {
        return { value: options[index].value };
      }
      emit(`Enter a number 1-${options.length}, or q to quit.\n`);
    }
  }
  // ask / json: a free-text line.
  for (;;) {
    const line = await reader.nextLine();
    if (line === CANCEL) {
      return CANCEL;
    }
    const text = typeof line === "string" ? line : "";
    if (request.kind === "json") {
      try {
        return { value: JSON.parse(text) };
      } catch (err) {
        emit(`Not valid JSON (${err?.message ?? String(err)}). Try again, or Ctrl-C to quit.\n`);
        continue;
      }
    }
    return { value: text };
  }
}

/**
 * Prompt for and commit an answer to one pending human request, through the SAME
 * path the `smithers human answer` command uses: validate the value against the
 * request's stored schema, re-check the timeout, resolve the backing approval
 * (approveNode) when one is `requested`, then persist the answer. Returns
 * {@link CANCEL} if the operator quit, else a short outcome string.
 *
 * @param {any} request pending human-request row (carries kind/prompt/options/schema/iteration)
 * @param {{ adapter: any, reader: ReturnType<typeof createKeyReader>, emit: (t: string) => void, decidedBy?: string, now: () => number }} ctx
 * @returns {Promise<string | typeof CANCEL>}
 */
async function resolveHumanRequest(request, ctx) {
  const { adapter, reader, emit, decidedBy, now } = ctx;
  const options = parseSelectOptions(request.optionsJson);
  reader.drain();
  emit(renderHumanRequestPrompt(request, options));
  for (;;) {
    const answer = await readHumanValue(request, options, { reader, emit });
    if (answer === CANCEL) {
      return CANCEL;
    }
    const validation = validateHumanRequestValue(request, answer.value);
    if (!validation.ok) {
      emit(`${validation.message}\nTry again, or Ctrl-C to quit.\n`);
      continue;
    }
    // Re-fetch to confirm it is still pending and not past its timeout — the
    // human may have taken a while to type. Mirrors the `human answer` command.
    const fresh = await adapter.getHumanRequest(request.requestId);
    if (!fresh || fresh.status !== "pending") {
      emit(`Request ${request.requestId} is no longer pending; skipping.\n`);
      return "gone";
    }
    const answeredAtMs = now();
    if (isHumanRequestPastTimeout(fresh, answeredAtMs)) {
      await adapter.expireStaleHumanRequests(answeredAtMs);
      emit(`Request ${request.requestId} expired before it could be answered.\n`);
      return "expired";
    }
    const responseJson = JSON.stringify(answer.value);
    try {
      const approval = await adapter.getApproval(request.runId, request.nodeId, request.iteration);
      if (approval?.status === "requested") {
        await Effect.runPromise(
          approveNode(adapter, request.runId, request.nodeId, request.iteration, responseJson, decidedBy),
        );
      }
      await adapter.answerHumanRequest(request.requestId, responseJson, answeredAtMs, decidedBy ?? null);
      emit(`✓ answered ${request.nodeId}\n`);
    } catch (err) {
      emit(`✗ could not answer ${request.nodeId}: ${err?.message ?? String(err)}\n`);
      return COMMIT_FAILED;
    }
    return "answered";
  }
}

/**
 * Run the interactive approve/answer watch loop for a run until the run is
 * terminal or the operator quits. Fully injectable for tests (real DB, real
 * engine commits; only stdin/emit/timers are seams).
 *
 * @param {{
 *   adapter: any,
 *   runId: string,
 *   node?: string,
 *   stdin?: NodeJS.ReadStream | import("node:stream").Readable,
 *   emit?: (text: string) => void,
 *   decidedBy?: string,
 *   pollIntervalMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   linger?: (options: { stdin?: any, emit?: (text: string) => void }) => Promise<void>,
 *   resumeDetached?: (adapter: any, run: any, runId: string) => Promise<{ resumed: boolean, pid?: number | null }>,
 * }} params
 * @returns {Promise<{ status: string | undefined, cancelled: boolean }>}
 */
export async function runApproveWatch(params) {
  const adapter = params.adapter;
  const runId = params.runId;
  const node = params.node;
  const stdin = params.stdin ?? process.stdin;
  const emit = params.emit ?? ((text) => process.stdout.write(text));
  const pollIntervalMs = params.pollIntervalMs ?? APPROVE_WATCH_POLL_INTERVAL_MS;
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const lingerFn = params.linger ?? lingerUntilClosed;
  const resumeDetached = params.resumeDetached;

  const reader = createKeyReader(stdin, emit);
  let cancelled = false;
  /** @type {string | undefined} */
  let status;
  try {
    for (;;) {
      if (reader.cancelled()) {
        cancelled = true;
        break;
      }
      const pending = await findNextPending(adapter, runId, node);
      if (pending) {
        const outcome =
          pending.kind === "approval"
            ? await resolveApproval(pending.item, { adapter, reader, emit, decidedBy: params.decidedBy })
            : await resolveHumanRequest(pending.item, { adapter, reader, emit, decidedBy: params.decidedBy, now });
        if (outcome === CANCEL) {
          cancelled = true;
          break;
        }
        // A committed approve/deny/human decision on a detached run leaves it
        // parked (waiting-approval → waiting-event) with no live engine. Auto-
        // resume it, exactly as the non-watch approve/deny commands do, so the
        // re-armed node (or the on-deny path) actually runs instead of stranding.
        // Skip when the commit threw (COMMIT_FAILED): nothing was decided, so
        // resuming would print a misleading "↻ resuming" for a still-pending gate.
        if (resumeDetached && outcome !== COMMIT_FAILED) {
          try {
            const decided = await adapter.getRun(runId);
            if (decided) {
              const res = await resumeDetached(adapter, decided, runId);
              if (res && res.resumed) emit(`↻ resuming ${runId}\n`);
            }
          } catch {
            // Best-effort: a resume failure must never crash the pane.
          }
        }
        continue;
      }
      // Nothing actionable right now: stop if the run is terminal, else wait.
      const run = await adapter.getRun(runId);
      status = run ? deriveTailStatus(await computeRunStateFromRow(adapter, run)) : status;
      if (!run || !isTailActiveState(status)) {
        emit(`${formatTailFinalStatusLine(runId, status)}\n`);
        break;
      }
      await Promise.race([sleep(pollIntervalMs), reader.waitCancel()]);
    }
  } finally {
    reader.close();
  }
  if (!cancelled) {
    // Terminal reached naturally: hold the pane open so the operator can read
    // the final state, exactly as `tail --linger` does.
    await lingerFn({ stdin, emit });
  }
  return { status, cancelled };
}

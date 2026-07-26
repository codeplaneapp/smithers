import { spawn } from "node:child_process";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { formatEventLine } from "./format.js";

/**
 * The subtle one-line control hint shown at the start of a steerable LIVE tail:
 * `s` opens an in-pane input line that queues a steer for this node,
 * `h` hijacks the live agent session, `q` closes.
 */
export const TAIL_STEER_HINT = "s steer · h hijack · q close";

/**
 * The control hint shown during a finished run's linger: a steer cannot land
 * (every node is terminal), so only hijack (`h`) and close are offered.
 * Lowercase `s` explains why steer is gone (not a second hijack key).
 */
export const TAIL_LINGER_HINT = "h hijack · q close";

/** Message when the user presses `s` during linger (run already terminal). */
export const TAIL_LINGER_STEER_UNAVAILABLE =
  "(run finished — steer `s` only works while a node is working; press h to hijack, or q to close)\n";

/**
 * DB poll cadence for the tail follow loop: fast enough to feel live, slow
 * enough not to hammer the store. Mirrors the logs follow interval.
 */
export const TAIL_POLL_INTERVAL_MS = 500;

// Derived run states that mean the run is still producing events, so --follow
// should keep tailing. Mirrors the logs/watch follow-active set.
const TAIL_ACTIVE_STATES = new Set(["running", "waiting-approval", "waiting-event", "waiting-timer"]);

// Per-chunk / high-frequency event types the pretty run-level overview omits so
// it stays one concise line per significant event. NodeOutput is handled
// explicitly before this set is consulted (it is printed verbatim in --node
// mode and skipped in the overview).
const TAIL_NOISY_TYPES = new Set([
  "NodeOutput",
  "AgentEvent",
  "AgentSessionEvent",
  "AgentTraceEvent",
  "AgentTraceSummary",
  "TokenUsageReported",
  "TaskHeartbeat",
  "RunHeartbeat",
  "SandboxHeartbeat",
  "FrameCommitted",
  "SnapshotCaptured",
]);

/**
 * @param {unknown} payloadJson
 * @returns {Record<string, unknown>}
 */
function parseTailPayload(payloadJson) {
  if (typeof payloadJson !== "string") return {};
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore malformed payloads
  }
  return {};
}

/**
 * Raw event JSON line for --format jsonl. Shape matches `smithers events --json`
 * (buildEventNdjsonLine) so both commands emit identical machine output.
 *
 * @param {any} event
 * @returns {string}
 */
export function buildTailJsonlLine(event) {
  return JSON.stringify({
    runId: event.runId,
    seq: event.seq,
    timestampMs: event.timestampMs,
    type: event.type,
    payload: parseTailPayload(event.payloadJson),
  });
}

/**
 * Map a persisted event row to the exact text `smithers tail` should emit, or
 * `undefined` to skip it. The returned string is written verbatim (the caller
 * adds no newline), so NodeOutput chunks reproduce the agent's stream exactly.
 *
 * @param {any} event
 * @param {{ baseMs: number; nodeMode: boolean; jsonl: boolean }} options
 * @returns {string | undefined}
 */
export function renderTailEvent(event, options) {
  if (options.jsonl) {
    return `${buildTailJsonlLine(event)}\n`;
  }
  if (event.type === "NodeOutput") {
    // Verbatim per-node output (stdout/stderr interleaved) only in --node
    // mode; the run-level overview skips noisy per-chunk output.
    if (!options.nodeMode) return undefined;
    const text = parseTailPayload(event.payloadJson).text;
    return typeof text === "string" ? text : undefined;
  }
  if (TAIL_NOISY_TYPES.has(event.type)) {
    return undefined;
  }
  return `${formatEventLine(event, options.baseMs)}\n`;
}

/**
 * Derived run status, with the success state renamed to "finished" to match the
 * rest of the CLI (legacy ps naming).
 *
 * @param {import("@smithers-orchestrator/db/runState").RunStateView | undefined} view
 * @returns {string | undefined}
 */
export function deriveTailStatus(view) {
  const state = view?.state;
  return state === "succeeded" ? "finished" : state;
}

/**
 * @param {string | undefined} status
 * @returns {boolean}
 */
export function isTailActiveState(status) {
  return typeof status === "string" && TAIL_ACTIVE_STATES.has(status);
}

/**
 * One-line terminal-state summary printed when a pretty-format tail ends, so a
 * follow session (or an embedded tail pane) closes with a clear final marker.
 *
 * @param {string} runId
 * @param {string | undefined} status
 * @returns {string}
 */
export function formatTailFinalStatusLine(runId, status) {
  const symbol = status === "finished" ? "✓" : status === "failed" ? "✗" : status === "cancelled" ? "⊘" : "•";
  return `${symbol} Run ${runId} ${status ?? "ended"}`;
}

/**
 * Spawn `smithers steer <runId> --node <nodeId>` for a tail pane's OWN run+node.
 * The pane process already knows its ids (argv-derived) and carries the herdr
 * session env (herdr exports `HERDR_SOCKET_PATH` into panes, inherited here), so
 * steering is one key with zero ceremony — no cwd, env vars, run id, or hijack
 * flags to type. The CLI entry is resolved exactly like {@link buildTailCommand}
 * builds a pane's tail argv (this process's interpreter + the CLI entry path), so
 * it runs from a dev checkout too. With no `nodeId` (a whole-run/overview tail)
 * the `--node` filter is omitted and `steer` picks the run's hijackable node.
 *
 * With `takeover:true` it appends `--takeover` (the hijack hand-off); with a
 * `message` it appends the steer text as the trailing positional so `steer`
 * enqueues it non-interactively. The two are mutually exclusive at the pane
 * (`h` hijacks, `s`+Enter steers), but both may be passed and `steer` favours
 * hijack when `--takeover` is set.
 *
 * Best-effort: a spawn failure is swallowed and `undefined` returned, so the tail
 * keeps running. `spawnFn`/`execPath`/`env`/`stdio` are injectable for tests.
 *
 * @param {{
 *   runId: string,
 *   nodeId?: string,
 *   cliEntry: string,
 *   message?: string,
 *   takeover?: boolean,
 *   spawnFn?: typeof import("node:child_process").spawn,
 *   execPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdio?: import("node:child_process").StdioOptions,
 *   onOutput?: (text: string) => void,
 *   yes?: boolean,
 * }} options
 * @returns {import("node:child_process").ChildProcess | undefined}
 */
export function spawnSteer(options) {
  const spawnFn = options.spawnFn ?? spawn;
  const execPath = options.execPath ?? process.execPath;
  const argv = [execPath, options.cliEntry, "steer", options.runId];
  if (typeof options.nodeId === "string" && options.nodeId !== "") {
    argv.push("--node", options.nodeId);
  }
  if (options.takeover === true) {
    argv.push("--takeover");
  }
  if (options.yes === true) {
    argv.push("--yes");
  }
  if (typeof options.message === "string" && options.message !== "") {
    // Trailing positional (after the node option) — `steer` reads it as the
    // steer message. Passed as a single argv token, so its spaces survive.
    argv.push(options.message);
  }
  try {
    // Message steers default to piped stdio so an alt-screen node HUD is not
    // torn by CLI chrome; takeover still inherits unless the caller overrides
    // (herdr pane path pipes + SMITHERS_HERDR_HIJACK for a fresh tab).
    const stdio =
      options.stdio !== undefined
        ? options.stdio
        : typeof options.message === "string" && options.message !== ""
          ? ["ignore", "pipe", "pipe"]
          : "inherit";
    const child = spawnFn(argv[0], argv.slice(1), {
      stdio,
      env: options.env ?? process.env,
    });
    // Never let a steer spawn failure crash the tail that launched it.
    if (child && typeof child.on === "function") {
      child.on("error", () => {});
    }
    // When stdout/stderr are piped (node HUD), surface text via onOutput so
    // the parent can put errors in a banner instead of raw TTY under alt-screen.
    if (typeof options.onOutput === "function" && child) {
      const push = (buf) => {
        const t = buf?.toString?.() ?? String(buf ?? "");
        if (t.trim()) options.onOutput?.(t);
      };
      if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("data", push);
      if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("data", push);
    }
    return child;
  } catch {
    return undefined;
  }
}

/**
 * Wire raw-mode single-key controls onto a LIVE tail's stdin so an operator
 * focused on an agent's tail pane (herdr, or any TTY) can act with ONE key:
 *   s                            → open an in-pane input line ("steer: _") and
 *                                  queue a steer for this run+node when
 *                                  Enter is pressed (Esc / Ctrl-C cancel the line,
 *                                  Backspace edits it); the steer lands on the
 *                                  node's next agent step and the run never stops;
 *   h                            → hijack the run (spawn `smithers steer
 *                                  <runId> --node <nodeId> --takeover`), the
 *                                  session hand-off, gated by `steer`'s in-flight
 *                                  sibling warning;
 *   q / Enter / raw Ctrl-C (0x03) → close (invoke `onClose`, which cancels the
 *                                  tail so the caller exits cleanly).
 *
 * A ref'd `data` listener drives the keys; raw mode is enabled only on a TTY, so
 * a piped / non-TTY stdin is never put in raw mode. Under raw mode Ctrl-C arrives
 * as the ETX byte 0x03 and fires NO SIGINT, so it is matched explicitly (as in
 * {@link lingerUntilClosed}). Every listener + raw-mode change is undone by
 * `stop()`. The CALLER gates the wiring (TTY + not jsonl + a node tail); this
 * function itself always wires when called, so a unit test can drive it with a
 * `PassThrough` stdin. Takeover is debounced while its hand-off child is alive so
 * a key-repeat cannot fan out duplicate hijacks. `enqueue`/`onTakeover` are
 * injectable seams (default: spawn the matching `steer` invocation).
 *
 * @param {{
 *   runId: string,
 *   nodeId: string,
 *   cliEntry: string,
 *   onClose: () => void,
 *   stdin?: NodeJS.ReadStream,
 *   emit?: (text: string) => void,
 *   enqueue?: (message: string) => void,
 *   onTakeover?: () => void,
 *   spawnFn?: typeof import("node:child_process").spawn,
 *   execPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   onDock?: (state: { mode: "idle" | "input" | "linger", buffer?: string, note?: string }) => void,
 *   onSteerOutput?: (text: string) => void,
 *   inFlightSiblings?: () => Promise<string[]>,
 * }} options
 * @returns {{ stop: () => void }}
 */
export function attachTailKeyControls(options) {
  const stdin = options.stdin ?? process.stdin;
  const emit = options.emit ?? ((text) => process.stdout.write(text));
  const dock = options.onDock;
  let stopped = false;
  let rawModeSet = false;
  let takingOver = false;
  // In-pane steer input: while `inputMode` is set the tail collects a line of
  // text ("steer: _") instead of treating keys as controls.
  let inputMode = false;
  let buffer = "";
  // Queue the collected steer for this run+node. Injectable; the default spawns
  // `smithers steer <runId> --node <nodeId> <message>`, which enqueues it and
  // surfaces ack/errors via onSteerOutput (or emit) so alt-screen HUDs stay intact.
  const enqueue = (/** @type {string} */ message) => {
    if (options.enqueue) {
      options.enqueue(message);
      return;
    }
    const child = spawnSteer({
      runId: options.runId,
      nodeId: options.nodeId,
      cliEntry: options.cliEntry,
      message,
      spawnFn: options.spawnFn,
      execPath: options.execPath,
      env: options.env,
      onOutput: (t) => {
        if (options.onSteerOutput) options.onSteerOutput(t);
        else if (dock) dock({ mode: "idle", note: String(t).trim().slice(0, 80) });
        else emit(t);
      },
    });
    if (!child && dock) {
      dock({ mode: "idle", note: "steer spawn failed" });
    }
  };
  // Hand the run over (hijack). Debounced while the hand-off child is alive, and
  // — for the real stdio-inherit spawn — the tail's key reading is suspended
  // while the child owns the TTY (see `suspendKeys`/`rearmKeys` below).
  const takeover = async () => {
    if (takingOver) {
      return;
    }
    takingOver = true;
    if (dock) {
      dock({ mode: "idle", note: "taking over…" });
    } else {
      emit("taking over…\n");
    }
    if (options.onTakeover) {
      try {
        options.onTakeover();
      } finally {
        takingOver = false;
      }
      return;
    }
    // The hand-off child inherits this TTY. If we keep our raw-mode `data`
    // listener attached it competes with the child for keystrokes: a confirm
    // prompt gets split input, and an Enter can trip the close match below and
    // tear the pane down mid-confirm. So suspend key reading while the child is
    // alive and re-arm identically once it exits (close AND error).
    // Inside a herdr agent pane (HERDR_PANE_ID set): open hijack in a NEW tab
    // (full TTY + scrollback) instead of embedding Claude into this alt-screen
    // detail pane (no scroll, grey after exit). HERDR_ENV alone is not enough —
    // parent shells can inherit it without being a detail pane.
    const herdrEnv = options.env ?? process.env;
    const inHerdrPane =
      herdrEnv.HERDR_ENV === "1" && typeof herdrEnv.HERDR_PANE_ID === "string" && herdrEnv.HERDR_PANE_ID !== "";
    // Hijack aborts EVERY in-flight sibling agent run-wide (they re-run on
    // resume, losing mid-generate work). The real-terminal takeover confirms
    // that first; the herdr pane spawns non-interactively with --yes, which
    // would bypass the confirmation. So only auto-confirm when there are no
    // siblings to abort; otherwise refuse loudly instead of silently killing work.
    if (inHerdrPane && options.inFlightSiblings) {
      // `inFlightSiblings` returns the sibling node ids (a string[]), NOT a
      // count — guard on `.length`, and FAIL CLOSED on a read error: a
      // transient SQLite lock / closed adapter must not read as "zero
      // siblings" and wave through an auto-confirmed run-wide hijack.
      /** @type {string[] | null} */
      let siblings = null;
      let readFailed = false;
      try {
        siblings = await options.inFlightSiblings();
      } catch {
        readFailed = true;
      }
      if (readFailed || (siblings && siblings.length > 0)) {
        const detail = readFailed
          ? "could not verify in-flight sibling agents"
          : `${(siblings ?? []).length} sibling agent(s) in flight (${(siblings ?? []).join(", ")}) — hijack would abort them`;
        const warn = `⚠ ${detail}. Confirm from a real terminal: smithers steer ${options.runId} --node ${options.nodeId} --takeover`;
        if (dock) dock({ mode: "idle", note: warn });
        else emit(`${warn}\n`);
        takingOver = false;
        return;
      }
    }
    suspendKeys();
    const child = spawnSteer({
      runId: options.runId,
      nodeId: options.nodeId,
      cliEntry: options.cliEntry,
      takeover: true,
      yes: inHerdrPane,
      spawnFn: options.spawnFn,
      execPath: options.execPath,
      env: inHerdrPane ? { ...herdrEnv, SMITHERS_HERDR_HIJACK: herdrEnv.SMITHERS_HERDR_HIJACK || "1" } : herdrEnv,
      // herdr path: pipe so this pane keeps the HUD until we close it;
      // non-herdr: inherit TTY for interactive confirm + session.
      stdio: inHerdrPane ? ["ignore", "pipe", "pipe"] : "inherit",
      onOutput: (t) => {
        if (options.onSteerOutput) options.onSteerOutput(t);
        else if (dock) dock({ mode: "idle", note: String(t).trim().slice(0, 100) });
        else emit(t);
      },
    });
    if (child && typeof child.on === "function") {
      child.on("close", (code) => {
        takingOver = false;
        rearmKeys();
        if (dock) {
          dock({
            mode: "idle",
            note:
              code === 0
                ? inHerdrPane
                  ? "hijack tab opened — switch tabs to drive"
                  : "hijack finished"
                : "hijack failed — see banner",
          });
        }
      });
      child.on("error", () => {
        takingOver = false;
        rearmKeys();
        if (dock) dock({ mode: "idle", note: "hijack spawn failed" });
      });
    } else {
      takingOver = false;
      rearmKeys();
      if (dock) dock({ mode: "idle", note: "hijack spawn failed" });
    }
  };
  const submitInput = () => {
    const message = buffer.trim();
    inputMode = false;
    buffer = "";
    if (dock) {
      dock({ mode: "idle", buffer: "" });
    } else {
      emit("\n");
    }
    if (message) {
      enqueue(message);
    }
  };
  const cancelInput = () => {
    inputMode = false;
    buffer = "";
    if (dock) {
      dock({ mode: "idle", buffer: "", note: "steer cancelled" });
    } else {
      emit("\n(steer cancelled)\n");
    }
  };
  /** @param {string} text */
  const handleInputChars = (text) => {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      // Esc (also the lead byte of arrow-key sequences) or Ctrl-C cancels the
      // line without closing the tail; the rest of the chunk is discarded.
      if (code === 0x1b || code === 0x03) {
        cancelInput();
        return;
      }
      if (ch === "\r" || ch === "\n") {
        submitInput();
        return;
      }
      if (code === 0x7f || code === 0x08) {
        if (buffer.length > 0) {
          // Delete a whole code point, not one UTF-16 unit: a plain
          // `slice(0, -1)` would split an astral char (emoji) and leave a
          // lone surrogate. Iterate by code point via the spread.
          buffer = [...buffer].slice(0, -1).join("");
          if (dock) {
            dock({ mode: "input", buffer });
          } else {
            emit("\b \b");
          }
        }
        continue;
      }
      // Ignore other control bytes; echo printable input.
      if (code < 0x20) {
        continue;
      }
      buffer += ch;
      if (dock) {
        dock({ mode: "input", buffer });
      } else {
        emit(ch);
      }
    }
  };
  /** @param {Buffer | string} chunk */
  const onData = (chunk) => {
    const text = chunk.toString();
    if (inputMode) {
      handleInputChars(text);
      return;
    }
    const first = text.length > 0 ? text[0] : "";
    // `s` opens the steer input line; `h` hijacks (run-wide session hand-off).
    if (first === "s") {
      inputMode = true;
      buffer = "";
      if (dock) {
        dock({ mode: "input", buffer: "" });
      } else {
        emit("\nsteer: ");
      }
      return;
    }
    if (first === "h") {
      takeover();
      return;
    }
    // q / Q, Enter, or raw Ctrl-C (0x03, no SIGINT under raw mode) closes.
    if (/[qQ\r\n\u0003]/.test(text)) {
      options.onClose?.();
    }
  };
  // Suspend key reading while a stdio-inherit hand-off child owns the TTY: drop
  // the `data` listener, leave raw mode, and pause stdin so the child reads the
  // terminal cleanly. Re-armed by `rearmKeys` when the child exits.
  const suspendKeys = () => {
    if (typeof stdin.off === "function") {
      stdin.off("data", onData);
    }
    if (rawModeSet && typeof stdin.setRawMode === "function") {
      try {
        stdin.setRawMode(false);
      } catch {
        // stdin no longer a TTY: nothing to restore
      }
    }
    rawModeSet = false;
    if (typeof stdin.pause === "function") {
      try {
        stdin.pause();
      } catch {
        // best-effort: stdin may already be closed
      }
    }
  };
  // Re-arm key reading after the hand-off child exits, identically to the initial
  // wiring below. A no-op once the controls have been stopped, so a child that
  // closes after `stop()` cannot resurrect the listener.
  const rearmKeys = () => {
    if (stopped) {
      return;
    }
    try {
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
        rawModeSet = true;
      }
      if (typeof stdin.resume === "function") {
        stdin.resume();
      }
      stdin.on("data", onData);
    } catch {
      // stdin not usable for key reads: leave the controls disarmed.
    }
  };
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      rawModeSet = true;
    }
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
    stdin.on("data", onData);
  } catch {
    // stdin not usable for key reads (closed / not a stream): the tail still
    // runs, just without the single-key controls.
  }
  // Non-HUD tails print the key legend into the stream. Node HUD has a fixed
  // bottom dock — never dump the legend into the trace body.
  if (!dock) {
    emit(`${TAIL_STEER_HINT}\n`);
  }
  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (typeof stdin.off === "function") {
        stdin.off("data", onData);
      }
      if (rawModeSet && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(false);
        } catch {
          // stdin no longer a TTY: nothing to restore
        }
      }
      // Deliberately do NOT pause stdin: a following linger re-adds its own
      // listener and resumes; pausing here would race that handoff.
    },
  };
}

/**
 * Keep the process alive after a run has reached a terminal state so its output
 * stays readable, until the human closes it. Used by `smithers tail --linger`,
 * chiefly by herdr panes: without it a pane's `smithers tail` exits the instant
 * the run finishes, the pane process dies, and herdr tears the pane down about a
 * second later, so the "come back and see what happened" surface is gone.
 *
 * Resolves on SIGINT/SIGTERM or when the human presses `q` or Enter. When a
 * `steer` config is supplied (a node tail on a TTY), `h` takes the finished run
 * over (its resumable agent session is still hijackable) and the intro carries
 * the `h hijack · q close` hint — steer is not offered here because every
 * node is already terminal, so a queued steer could never be consumed. A ref'd
 * keepalive timer holds the event loop open regardless of whether stdin is a TTY,
 * a pipe, or `/dev/null`; every listener/timer/raw-mode change is undone before
 * resolving so the caller exits cleanly (exit code 0) afterward.
 *
 * @param {{
 *   emit?: (text: string) => void;
 *   stdin?: NodeJS.ReadStream;
 *   steer?: {
 *     runId: string,
 *     nodeId?: string,
 *     cliEntry: string,
 *     spawnFn?: typeof import("node:child_process").spawn,
 *     execPath?: string,
 *     env?: NodeJS.ProcessEnv,
 *   };
 *   suppressChromeHints?: boolean;
 * }} [options]
 * @returns {Promise<void>}
 */
export function lingerUntilClosed(options = {}) {
  const emit = options.emit ?? ((text) => process.stdout.write(text));
  const stdin = options.stdin ?? process.stdin;
  const steer = options.steer;
  // Node HUD already shows [ h hijack ] [ q close ] in the dock — keep the
  // stream body for agent output only.
  if (!options.suppressChromeHints) {
    emit("Lingering so you can read the output. Press q or Enter (or Ctrl-C) to close.\n");
    if (steer) {
      emit(`${TAIL_LINGER_HINT}\n`);
    }
  }
  return new Promise((resolve) => {
    let done = false;
    let rawModeSet = false;
    let takingOver = false;
    /** @type {ReturnType<typeof setInterval>} */
    let keepAlive;
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      const text = chunk.toString();
      // While lingering the run is terminal: steer cannot land on any node.
      // - `s` explains (not hijack)
      // - `h` attempts hijack when a real agent session exists.
      if (steer) {
        if (text === "s") {
          emit(TAIL_LINGER_STEER_UNAVAILABLE);
          return;
        }
        if (text === "h") {
          if (!takingOver) {
            takingOver = true;
            emit("hijacking…\n");
            // Suspend key reading while hijack child runs. Prefer piped
            // stdio when the host HUD can show errors in a banner; fall
            // back to inherit for plain terminal linger.
            suspendKeys();
            const child = spawnSteer({
              runId: steer.runId,
              nodeId: steer.nodeId,
              cliEntry: steer.cliEntry,
              takeover: true,
              spawnFn: steer.spawnFn,
              execPath: steer.execPath,
              env: steer.env,
              stdio: steer.stdio ?? "inherit",
              onOutput: emit,
            });
            if (child && typeof child.on === "function") {
              child.on("close", (code) => {
                takingOver = false;
                rearmKeys();
                if (code && code !== 0) {
                  emit(`hijack exited with code ${code}\n`);
                }
              });
              child.on("error", (err) => {
                takingOver = false;
                rearmKeys();
                emit(`hijack error: ${err instanceof Error ? err.message : String(err)}\n`);
              });
            } else {
              takingOver = false;
              rearmKeys();
            }
          }
          return;
        }
      }
      // q / Q, Enter (CR or LF), or Ctrl-C closes the linger. A herdr pane's
      // stdin is a raw-mode TTY (setRawMode(true) below disables ISIG), so
      // Ctrl-C arrives as the raw ETX byte 0x03 on stdin and fires NO SIGINT —
      // match  explicitly or Ctrl-C is dead inside a real linger pane and
      // only q / Enter / a kill signal can close it.
      if (/[qQ\r\n\u0003]/.test(text)) {
        finish();
      }
    };
    const onSignal = () => finish();
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearInterval(keepAlive);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (stdin) {
        if (typeof stdin.off === "function") {
          stdin.off("data", onData);
        }
        if (rawModeSet && typeof stdin.setRawMode === "function") {
          try {
            stdin.setRawMode(false);
          } catch {
            // stdin no longer a TTY: nothing to restore
          }
        }
        if (typeof stdin.pause === "function") {
          try {
            stdin.pause();
          } catch {
            // best-effort: stdin may already be closed
          }
        }
      }
      resolve();
    };
    // Suspend key reading while a stdio-inherit hand-off child owns the TTY, and
    // re-arm identically when it exits (close AND error). Mirrors the live-tail
    // controls so a hijack from the linger does not race the child for keys.
    const suspendKeys = () => {
      if (typeof stdin?.off === "function") {
        stdin.off("data", onData);
      }
      if (rawModeSet && typeof stdin?.setRawMode === "function") {
        try {
          stdin.setRawMode(false);
        } catch {
          // stdin no longer a TTY: nothing to restore
        }
      }
      rawModeSet = false;
      if (typeof stdin?.pause === "function") {
        try {
          stdin.pause();
        } catch {
          // best-effort: stdin may already be closed
        }
      }
    };
    const rearmKeys = () => {
      // The linger already closed while the child was alive: stay off.
      if (done || !stdin) {
        return;
      }
      try {
        if (stdin.isTTY && typeof stdin.setRawMode === "function") {
          stdin.setRawMode(true);
          rawModeSet = true;
        }
        if (typeof stdin.resume === "function") {
          stdin.resume();
        }
        stdin.on("data", onData);
      } catch {
        // stdin not usable for key reads: rely on the signal handlers.
      }
    };
    // A ref'd no-op interval keeps the event loop alive until a key or signal
    // arrives, independent of stdin being readable (a herdr pane's stdin is a
    // TTY; a piped or ignored stdin reaches EOF immediately, which must NOT end
    // the linger — only an explicit keypress or signal should).
    keepAlive = setInterval(() => {}, 1 << 30);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (stdin) {
      try {
        if (stdin.isTTY && typeof stdin.setRawMode === "function") {
          stdin.setRawMode(true);
          rawModeSet = true;
        }
        if (typeof stdin.resume === "function") {
          stdin.resume();
        }
        stdin.on("data", onData);
      } catch {
        // stdin not usable for key reads (closed / not a stream): rely on
        // the signal handlers to close the linger.
      }
    }
  });
}

/**
 * Page through persisted events after `afterSeq` (node-filtered when `nodeId` is
 * set), invoking `onEvent` for each event as it is read so at most one page is
 * ever resident — a run with a huge volume of NodeOutput streams line-by-line
 * instead of being accumulated into memory before printing. Read-only. Returns
 * the last seq observed (the caller's next cursor).
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {string | undefined} nodeId
 * @param {number} afterSeq
 * @param {(event: any) => void} onEvent
 * @returns {Promise<number>}
 */
async function drainEventsAfter(adapter, runId, nodeId, afterSeq, onEvent) {
  let cursor = afterSeq;
  while (true) {
    const page = await adapter.listEventHistoryEffect(runId, {
      afterSeq: cursor,
      ...(nodeId ? { nodeId } : undefined),
      limit: 1000,
    });
    if (!page || page.length === 0) break;
    for (const event of page) {
      onEvent(event);
      cursor = event.seq;
    }
    if (page.length < 1000) break;
  }
  return cursor;
}

/**
 * DB-backed tail loop shared by `smithers tail` and reusable by other
 * event-stream consumers (e.g. a mirrored presentation plane). Renders and
 * emits every persisted event, then — when the run is still active and `follow`
 * is set — polls the store for new events until the run reaches a terminal
 * state. Never writes to the DB. Returns the final derived run status.
 *
 * @param {any} adapter SmithersDb adapter (read-only usage)
 * @param {any} run run row from adapter.getRun
 * @param {{
 *   nodeId?: string;
 *   jsonl?: boolean;
 *   follow?: boolean;
 *   baseMs: number;
 *   emit: (text: string) => void;
 *   pollIntervalMs?: number;
 *   isCancelled?: () => boolean;
 *   onStatusBlock?: (status: string | undefined) => Promise<void> | void;
 * }} options
 * @returns {Promise<string | undefined>}
 */
export async function tailRunEvents(adapter, run, options) {
  const runId = run.runId;
  const nodeId = options.nodeId;
  const nodeMode = Boolean(nodeId);
  const jsonl = Boolean(options.jsonl);
  const follow = options.follow !== false;
  const pollIntervalMs = options.pollIntervalMs ?? TAIL_POLL_INTERVAL_MS;
  let lastSeq = -1;
  /** @param {any} event */
  const emitEvent = (event) => {
    const text = renderTailEvent(event, { baseMs: options.baseMs, nodeMode, jsonl });
    if (text !== undefined) options.emit(text);
  };
  lastSeq = await drainEventsAfter(adapter, runId, nodeId, lastSeq, emitEvent);
  let status = deriveTailStatus(await computeRunStateFromRow(adapter, run));
  // Optional run-level overview board (`--overview`): emitted after each drain,
  // interleaved with the event scroll. The hook self-dedupes (reprints only on a
  // node-state change) so an append-only tail is not spammed.
  await options.onStatusBlock?.(status);
  if (!follow || !isTailActiveState(status)) {
    return status;
  }
  while (true) {
    if (options.isCancelled?.()) return status;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    lastSeq = await drainEventsAfter(adapter, runId, nodeId, lastSeq, emitEvent);
    const currentRun = await adapter.getRun(runId);
    status = currentRun ? deriveTailStatus(await computeRunStateFromRow(adapter, currentRun)) : status;
    await options.onStatusBlock?.(status);
    if (!isTailActiveState(status)) {
      // Drain any events written between the last poll and the terminal
      // transition, then stop so the follow session ends cleanly.
      lastSeq = await drainEventsAfter(adapter, runId, nodeId, lastSeq, emitEvent);
      await options.onStatusBlock?.(status);
      return status;
    }
  }
}

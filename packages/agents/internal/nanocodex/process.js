import { spawn } from "node:child_process";
import { constants as fsConstants, accessSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

import { parseNanocodexJson } from "./protocol.js";

const DEFAULT_MAX_LINE_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_INPUT_RECORD_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_PROTOCOL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 1_000;
const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_KILL_WAIT_MS = 1_000;
const DEFAULT_TERMINAL_EXIT_GRACE_MS = 1_000;
const MAX_RUNTIME_DELAY_MS = 2 ** 31 - 1;
const MAX_CRASH_STDERR_BYTES = 4 * 1024;
const MAX_TRACKED_DESCENDANTS = 4_096;
const STDIN_WRITE_FAILURE = Symbol("NanocodexStdinWriteFailure");

/** @typedef {"aborted" | "timeout" | "idle_timeout"} NanocodexCancellationReason */

/**
 * @typedef {{
 *   send(record: unknown): Promise<void>;
 *   start(record: unknown): Promise<void>;
 *   markTerminal(record: unknown): void;
 *   readonly pid: number | undefined;
 * }} NanocodexProcessControl
 */

/**
 * @typedef {{
 *   command: string;
 *   args?: string[];
 *   cwd: string;
 *   env: Record<string, string | undefined>;
 *   inheritEnv: boolean;
 *   validateRecord(value: unknown): unknown | Promise<unknown>;
 *   isHello(record: unknown): boolean;
 *   onHello(record: unknown, control: NanocodexProcessControl): void | Promise<void>;
 *   onRecord?: (record: unknown, control: NanocodexProcessControl) => void | Promise<void>;
 *   onCancel?: (context: { reason: NanocodexCancellationReason; send(record: unknown): Promise<void> }) => void | Promise<void>;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 *   idleTimeoutMs?: number;
 *   maxLineBytes?: number;
 *   maxInputRecordBytes?: number;
 *   maxProtocolBytes?: number;
 *   maxStderrBytes?: number;
 *   cancelGraceMs?: number;
 *   termGraceMs?: number;
 *   killWaitMs?: number;
 *   terminalExitGraceMs?: number;
 *   onStderr?: (text: string) => void;
 *   onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void;
 *   spawnFn?: typeof spawn;
 *   killFn?: typeof process.kill;
 * }} RunNanocodexProcessOptions
 */

/**
 * @typedef {{
 *   terminal: unknown;
 *   exitCode: number | null;
 *   signal: NodeJS.Signals | null;
 *   stderr: string;
 *   stderrTruncated: boolean;
 * }} RunNanocodexProcessResult
 */

/**
 * Run one private Nanocodex JSONL bridge child to exit.
 *
 * The child is spawned without a shell. `cwd`, `env`, and `inheritEnv` are
 * deliberately explicit so credentials are inherited only when the adapter
 * opts in. `args` must contain only non-secret executable switches; commands,
 * prompts, credentials, and snapshots belong in `send()` JSONL records.
 *
 * Each stdout line is decoded as strict UTF-8, parsed once, and passed to the
 * caller's protocol validator. The first validated record must satisfy
 * `isHello`; only then is `onHello` invoked, which is where the caller sends
 * `turn.start`. Later validated records are delivered serially to `onRecord`.
 * Call `control.markTerminal(record)` after accepting the authoritative
 * terminal; the returned result includes that exact record and does not turn a
 * subsequent non-zero exit into a crash.
 *
 * Abort and timer cancellation call `onCancel` once so the caller can construct
 * a request/session-correlated `turn.cancel`. Cleanup then escalates through a
 * bounded graceful wait, SIGTERM, and SIGKILL. The bridge is spawned directly,
 * the same class as other Smithers CLI agents. Linux `detached` process-group
 * signaling and guarded `/proc` tracking are supplemental best-effort cleanup,
 * not a launch gate and not PID-namespace-authoritative. Isolation, if any,
 * is an outer Smithers `<Sandbox>`, not this argv.
 *
 * The promise settles once. Failures expose a stable `code` property and only
 * bounded, redacted stderr; command arguments are never copied into errors.
 *
 * @param {RunNanocodexProcessOptions} options
 * @returns {Promise<RunNanocodexProcessResult>}
 */
export async function runNanocodexProcess(options) {
  assertOptions(options);

  const maxLineBytes = finiteNonNegativeInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
  const maxInputRecordBytes = finiteNonNegativeInteger(
    options.maxInputRecordBytes,
    DEFAULT_MAX_INPUT_RECORD_BYTES,
    "maxInputRecordBytes",
  );
  const maxProtocolBytes = finiteNonNegativeInteger(
    options.maxProtocolBytes,
    DEFAULT_MAX_PROTOCOL_BYTES,
    "maxProtocolBytes",
  );
  const maxStderrBytes = finiteNonNegativeInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes");
  const cancelGraceMs = finiteTimerWithDefault(options.cancelGraceMs, DEFAULT_CANCEL_GRACE_MS, "cancelGraceMs");
  const termGraceMs = finiteTimerWithDefault(options.termGraceMs, DEFAULT_TERM_GRACE_MS, "termGraceMs");
  const killWaitMs = finiteTimerWithDefault(options.killWaitMs, DEFAULT_KILL_WAIT_MS, "killWaitMs");
  const terminalExitGraceMs = finiteTimerWithDefault(
    options.terminalExitGraceMs,
    DEFAULT_TERMINAL_EXIT_GRACE_MS,
    "terminalExitGraceMs",
  );
  const timeoutMs = optionalFiniteTimer(options.timeoutMs, "timeoutMs");
  const idleTimeoutMs = optionalFiniteTimer(options.idleTimeoutMs, "idleTimeoutMs");
  const effectiveEnv = normalizedEnvironment(options.env, options.inheritEnv);
  const redact = createStderrSuppressor(maxStderrBytes);

  if (options.signal?.aborted) {
    throw processError("bridge_aborted", "Nanocodex bridge was aborted before it started.", {
      reason: "aborted",
      stderr: "",
      stderrTruncated: false,
    });
  }

  const spawnSpec = createNanocodexSpawnSpec(options.command, options.args ?? [], effectiveEnv, options.cwd);

  return new Promise((resolve, reject) => {
    const stderrCapture = createBoundedCapture(maxStderrBytes);
    const spawnFn = options.spawnFn ?? spawn;
    const killFn = options.killFn ?? process.kill.bind(process);
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
    let child;

    try {
      child = /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (
        spawnFn(spawnSpec.command, spawnSpec.args, {
          cwd: options.cwd,
          env: effectiveEnv,
          shell: false,
          detached: process.platform === "linux",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      );
    } catch (error) {
      reject(spawnFailure(error));
      return;
    }

    let settled = false;
    let exitNotified = false;
    let childClosed = false;
    let sawHello = false;
    let terminalMarked = false;
    let terminalRecord;
    let spawnErrorCode;
    let pendingError;
    let initialStartWriteFailed = false;
    /** @type {"not_started" | "running" | "succeeded" | "failed"} */
    let helloHandlerState = "not_started";
    /** @type {"not_started" | "writing" | "sent" | "failed"} */
    let startState = "not_started";
    let insideHelloHandler = false;
    /** @type {Promise<void> | undefined} */
    let cancellationWrite;
    /** @type {NanocodexCancellationReason | undefined} */
    let cancellationReason;
    /** @type {number | null} */
    let closeCode = null;
    /** @type {NodeJS.Signals | null} */
    let closeSignal = null;
    /** @type {Buffer[]} */
    let lineChunks = [];
    let lineBytes = 0;
    let protocolBytes = 0;
    let stdoutFlushed = false;
    let recordQueue = Promise.resolve();
    let writeQueue = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let totalTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let idleTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let termTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let killTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let forceSettleTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let terminalExitTimer;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let censusTimer;
    /** @type {{ pid: number; startTime: string } | undefined} */
    let rootIdentity;
    /** @type {Map<number, { pid: number; startTime: string }>} */
    const descendants = new Map();
    let descendantCensusOverflow = false;
    let lastCensusAt = 0;

    const clearActivityTimers = () => {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      totalTimer = undefined;
      idleTimer = undefined;
    };

    const clearTerminationTimers = () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(forceSettleTimer);
      clearTimeout(terminalExitTimer);
      termTimer = undefined;
      killTimer = undefined;
      forceSettleTimer = undefined;
      terminalExitTimer = undefined;
    };

    const cleanupListeners = () => {
      clearActivityTimers();
      clearTerminationTimers();
      clearInterval(censusTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdin.removeListener("error", onStdinError);
      child.stdout.removeListener("data", onStdoutData);
      child.stdout.removeListener("end", onStdoutEnd);
      child.stdout.removeListener("error", onStdoutError);
      child.stderr.removeListener("data", onStderrData);
      child.stderr.removeListener("error", onStderrError);
      child.removeListener("error", onChildError);
      child.removeListener("close", onChildClose);
    };

    /** @param {boolean} force */
    const refreshDescendants = (force = false) => {
      if (process.platform !== "linux" || child.pid == null) return;
      const now = Date.now();
      if (!force && now - lastCensusAt < 50) return;
      lastCensusAt = now;

      if (!rootIdentity && !childClosed) {
        rootIdentity = readLinuxIdentity(child.pid);
      }
      if (rootIdentity) {
        const census = censusLinuxDescendants(rootIdentity, descendants);
        if (census.overflow && !descendantCensusOverflow) {
          descendantCensusOverflow = true;
          clearActivityTimers();
          scheduleSignals(0);
        }
      }
    };

    /** @returns {Array<{ pid: number; startTime: string }>} */
    const liveDescendants = () => {
      refreshDescendants(true);
      const live = [];
      for (const identity of descendants.values()) {
        if (sameLiveLinuxIdentity(identity)) live.push(identity);
        else descendants.delete(identity.pid);
      }
      return live;
    };

    /** @param {NodeJS.Signals} signal */
    const signalDescendants = (signal) => {
      for (const identity of liveDescendants()) {
        if (identity.pid === process.pid || !sameLiveLinuxIdentity(identity)) continue;
        try {
          killFn(identity.pid, signal);
        } catch {
          // The descendant exited after its identity check.
        }
      }
    };

    /** @param {NodeJS.Signals} signal */
    const signalRoot = (signal) => {
      if (child.pid == null || childClosed) return;
      if (process.platform === "linux") {
        if (rootIdentity && sameLinuxIdentity(rootIdentity)) {
          try {
            killFn(-rootIdentity.pid, signal);
            return;
          } catch {
            // Fall through to the direct child handle.
          }
        } else if (rootIdentity) {
          return;
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The direct child exited between the close check and signal.
      }
    };

    /** @param {NodeJS.Signals} signal */
    const signalTree = (signal) => {
      refreshDescendants(true);
      signalDescendants(signal);
      signalRoot(signal);
      // Enumerate once more to narrow the fork-during-signal race.
      refreshDescendants(true);
      signalDescendants(signal);
    };

    const forceSettlementAfterKill = () => {
      clearTimeout(forceSettleTimer);
      forceSettleTimer = setTimeout(() => {
        signalTree("SIGKILL");
        if (childClosed || settled) return;
        const survivingProcesses = (rootIdentity && sameLinuxIdentity(rootIdentity) ? 1 : 0) + liveDescendants().length;
        if (survivingProcesses > 0) {
          settleReject(
            retainTerminal(
              processError("bridge_cleanup_failed", "Nanocodex bridge processes survived forced cleanup.", {
                survivingProcesses,
                stderr: redact(stderrCapture.text()),
                stderrTruncated: stderrCapture.truncated(),
              }),
              terminalMarked,
              terminalRecord,
            ),
          );
          return;
        }
        // The OS process is gone. Node may still be waiting on inherited stdio
        // from an unobserved reparented grandchild. Supplemental census is not
        // PID-namespace-authoritative, so treat the handle as closed.
        onChildClose(closeCode, closeSignal);
      }, killWaitMs);
      forceSettleTimer.unref?.();
    };

    /** @param {number} graceMs */
    const scheduleSignals = (graceMs) => {
      if (termTimer || killTimer || childClosed || settled) return;
      termTimer = setTimeout(() => {
        termTimer = undefined;
        signalTree("SIGTERM");
        killTimer = setTimeout(() => {
          killTimer = undefined;
          signalTree("SIGKILL");
          forceSettlementAfterKill();
        }, termGraceMs);
        killTimer.unref?.();
      }, graceMs);
      termTimer.unref?.();
    };

    /** @param {Error} error */
    const beginFailure = (error) => {
      if (settled || pendingError || cancellationReason || initialStartWriteFailed) return;
      pendingError = error;
      clearActivityTimers();
      scheduleSignals(0);
    };

    const beginInitialStartWriteFailure = () => {
      if (settled || pendingError || cancellationReason || initialStartWriteFailed) return;
      initialStartWriteFailed = true;
      clearActivityTimers();
      scheduleSignals(0);
    };

    /** @param {NanocodexCancellationReason} reason */
    const beginCancellation = (reason) => {
      if (settled || childClosed || cancellationReason || pendingError || initialStartWriteFailed || terminalMarked) {
        return;
      }
      cancellationReason = reason;
      clearActivityTimers();
      void coordinateCancellation(reason);
    };

    /** @param {NanocodexCancellationReason} reason */
    async function coordinateCancellation(reason) {
      if (!options.onCancel || startState === "not_started" || helloHandlerState === "not_started") {
        scheduleSignals(0);
        return;
      }

      const deadline = Date.now() + cancelGraceMs;
      if (
        !["running", "succeeded"].includes(helloHandlerState) ||
        !["writing", "sent"].includes(startState) ||
        childClosed ||
        settled
      ) {
        scheduleSignals(0);
        return;
      }

      const sendCancellation = (record) => {
        cancellationWrite ??= send(record);
        return cancellationWrite;
      };
      let handlerResult;
      try {
        // Invoke synchronously so the cancel is queued before a zero-delay
        // escalation timer can run.
        handlerResult = Promise.resolve(options.onCancel({ reason, send: sendCancellation }));
      } catch {
        handlerResult = Promise.resolve();
      }
      await settleWithin(handlerResult, Math.max(0, deadline - Date.now()));
      if (cancellationWrite) {
        await settleWithin(cancellationWrite, Math.max(0, deadline - Date.now()));
      }
      if (!terminalMarked) scheduleSignals(Math.max(0, deadline - Date.now()));
    }

    const resetIdleTimer = () => {
      if (idleTimeoutMs == null || cancellationReason || pendingError || terminalMarked || childClosed || settled) {
        return;
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => beginCancellation("idle_timeout"), idleTimeoutMs);
      idleTimer.unref?.();
    };

    /** @param {unknown} record */
    const markTerminal = (record) => {
      if (terminalMarked) {
        throw new Error("The Nanocodex bridge emitted more than one terminal record.");
      }
      terminalMarked = true;
      terminalRecord = record;
      clearActivityTimers();
      terminalExitTimer = setTimeout(() => scheduleSignals(0), terminalExitGraceMs);
      terminalExitTimer.unref?.();
    };

    const control = {
      send: sendFromControl,
      start: sendStart,
      markTerminal,
      get pid() {
        return child.pid;
      },
    };

    /**
     * The first control write made by onHello opens the turn. Existing adapters
     * therefore receive the same cancellation ordering as the explicit start()
     * API without maintaining their own post-write flag.
     * @param {unknown} record
     */
    function sendFromControl(record) {
      if (insideHelloHandler && startState === "not_started") return sendStart(record);
      return send(record);
    }

    /** @param {unknown} record */
    async function sendStart(record) {
      if (startState !== "not_started") {
        throw processError("bridge_input_error", "Nanocodex turn.start was already sent.");
      }
      if (cancellationReason) {
        throw processError("bridge_input_error", "Nanocodex turn.start was cancelled before it could be sent.");
      }
      startState = "writing";
      try {
        await send(record);
        startState = "sent";
      } catch (error) {
        startState = "failed";
        throw error;
      }
    }

    /** @param {unknown} record */
    async function send(record) {
      let body;
      try {
        body = JSON.stringify(record);
        if (body === undefined) throw new Error("not serializable");
      } catch {
        throw processError("bridge_input_error", "Nanocodex command is not JSON serializable.");
      }
      // The advertised JSONL record limit counts only the UTF-8 body. The LF
      // delimiter is appended after this exact boundary check.
      if (Buffer.byteLength(body, "utf8") > maxInputRecordBytes) {
        throw processError("bridge_input_error", `Nanocodex command exceeded ${maxInputRecordBytes} input bytes.`);
      }
      const payload = `${body}\n`;

      const write = () =>
        new Promise((writeResolve, writeReject) => {
          if (settled || childClosed || child.stdin.destroyed || !child.stdin.writable) {
            writeReject(stdinWriteError("Nanocodex bridge stdin is closed."));
            return;
          }
          try {
            child.stdin.write(payload, "utf8", (error) => {
              if (error) writeReject(stdinWriteError("Could not write to Nanocodex bridge stdin."));
              else writeResolve();
            });
          } catch {
            writeReject(stdinWriteError("Could not write to Nanocodex bridge stdin."));
          }
        });
      const pendingWrite = writeQueue.then(write, write);
      writeQueue = pendingWrite.catch(() => {});
      return pendingWrite;
    }

    /** @param {Buffer} bytes */
    const queueLine = (bytes) => {
      if (bytes.byteLength === 0 || pendingError || initialStartWriteFailed || settled) return;
      recordQueue = recordQueue.then(async () => {
        if (pendingError || initialStartWriteFailed || settled) return;
        let text;
        let parsed;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          beginFailure(protocolError("Nanocodex bridge stdout contained invalid UTF-8."));
          return;
        }
        try {
          parsed = parseNanocodexJson(text);
        } catch {
          beginFailure(protocolError("Nanocodex bridge stdout contained invalid JSONL."));
          return;
        }

        let record;
        try {
          record = await options.validateRecord(parsed);
        } catch {
          beginFailure(protocolError("Nanocodex bridge emitted an invalid protocol record."));
          return;
        }

        if (!sawHello) {
          let hello;
          try {
            hello = options.isHello(record);
          } catch {
            beginFailure(protocolError("Nanocodex bridge hello validation failed."));
            return;
          }
          if (!hello) {
            beginFailure(protocolError("Nanocodex bridge emitted a record before hello."));
            return;
          }
          sawHello = true;
          if (cancellationReason) return;
          helloHandlerState = "running";
          insideHelloHandler = true;
          try {
            await options.onHello(record, control);
            helloHandlerState = "succeeded";
          } catch (error) {
            helloHandlerState = "failed";
            if (error?.[STDIN_WRITE_FAILURE] && startState === "failed") beginInitialStartWriteFailure();
            else beginFailure(processError("bridge_handler_error", "Nanocodex hello handler failed."));
          } finally {
            insideHelloHandler = false;
          }
          return;
        }

        try {
          if (options.isHello(record)) {
            beginFailure(protocolError("Nanocodex bridge emitted hello more than once."));
            return;
          }
        } catch {
          beginFailure(protocolError("Nanocodex bridge record validation failed."));
          return;
        }

        try {
          await options.onRecord?.(record, control);
        } catch {
          beginFailure(processError("bridge_handler_error", "Nanocodex record handler failed."));
        }
      });
    };

    /** @param {Buffer} chunk */
    function onStdoutData(chunk) {
      if (settled || pendingError || initialStartWriteFailed) return;
      resetIdleTimer();
      refreshDescendants();
      protocolBytes += chunk.byteLength;
      if (protocolBytes > maxProtocolBytes) {
        beginFailure(protocolError(`Nanocodex bridge stdout exceeded ${maxProtocolBytes} aggregate bytes.`));
        return;
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.byteLength : newline;
        let segment = chunk.subarray(offset, end);
        if (lineBytes + segment.byteLength > maxLineBytes) {
          lineChunks = [];
          lineBytes = 0;
          beginFailure(protocolError(`Nanocodex bridge stdout line exceeded ${maxLineBytes} bytes.`));
          return;
        }
        if (segment.byteLength > 0) {
          lineChunks.push(segment);
          lineBytes += segment.byteLength;
        }
        if (newline !== -1) {
          let line = Buffer.concat(lineChunks, lineBytes);
          if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) line = line.subarray(0, -1);
          queueLine(line);
          lineChunks = [];
          lineBytes = 0;
          offset = newline + 1;
        } else {
          offset = chunk.byteLength;
        }
      }
    }

    function onStdoutEnd() {
      if (stdoutFlushed) return;
      stdoutFlushed = true;
      if (lineBytes > 0) queueLine(Buffer.concat(lineChunks, lineBytes));
      lineChunks = [];
      lineBytes = 0;
    }

    /** @param {Error} _error */
    function onStdoutError(_error) {
      beginFailure(protocolError("Could not read Nanocodex bridge stdout."));
    }

    /** @param {Buffer} chunk */
    function onStderrData(chunk) {
      stderrCapture.append(chunk);
      resetIdleTimer();
      refreshDescendants();
    }

    /** @param {Error} _error */
    function onStderrError(_error) {
      beginFailure(protocolError("Could not read Nanocodex bridge stderr."));
    }

    /** @param {Error & { code?: string }} error */
    function onChildError(error) {
      spawnErrorCode = typeof error.code === "string" ? error.code : "SPAWN_FAILED";
    }

    /** @param {Error} _error */
    function onStdinError(_error) {
      // write() observes its own callback error; this listener prevents an unhandled EPIPE.
    }

    function onAbort() {
      beginCancellation("aborted");
    }

    /**
     * @param {number | null} code
     * @param {NodeJS.Signals | null} signal
     */
    function onChildClose(code, signal) {
      if (childClosed) return;
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (!exitNotified) {
        exitNotified = true;
        try {
          options.onProcess?.({ phase: "exited", pid: child.pid });
        } catch {
          // Observability callbacks never own the child lifecycle.
        }
      }
      clearActivityTimers();
      clearTerminationTimers();
      options.signal?.removeEventListener("abort", onAbort);
      onStdoutEnd();
      void finalizeAfterRecordQueue(recordQueue);
    }

    /** @param {Promise<void>} queue */
    async function finalizeAfterRecordQueue(queue) {
      const drained = await settleWithin(queue, killWaitMs);
      if (!drained && !pendingError && !cancellationReason && !terminalMarked) {
        if (helloHandlerState === "running" && startState === "writing") initialStartWriteFailed = true;
        else pendingError = processError("bridge_handler_error", "Nanocodex handler did not settle after bridge exit.");
      }
      await finalizeAfterClose();
    }

    async function cleanupSurvivingDescendants() {
      if (process.platform !== "linux") return true;
      let live = liveDescendants();
      if (live.length === 0) return !descendantCensusOverflow;
      signalDescendants("SIGTERM");
      if (termGraceMs > 0) await delay(termGraceMs);
      live = liveDescendants();
      if (live.length === 0) return !descendantCensusOverflow;
      signalDescendants("SIGKILL");
      const deadline = Date.now() + killWaitMs;
      while (Date.now() < deadline) {
        await delay(Math.min(20, Math.max(1, deadline - Date.now())));
        if (liveDescendants().length === 0) return !descendantCensusOverflow;
        signalDescendants("SIGKILL");
      }
      signalDescendants("SIGKILL");
      return liveDescendants().length === 0 && !descendantCensusOverflow;
    }

    async function finalizeAfterClose() {
      if (settled) return;
      if (!(await cleanupSurvivingDescendants())) {
        settleReject(
          retainTerminal(
            processError(
              "bridge_cleanup_failed",
              descendantCensusOverflow
                ? `Nanocodex bridge exceeded the ${MAX_TRACKED_DESCENDANTS}-descendant cleanup census limit.`
                : "Nanocodex bridge descendants survived forced cleanup.",
              {
                stderr: redact(stderrCapture.text()),
                stderrTruncated: stderrCapture.truncated(),
              },
            ),
            terminalMarked,
            terminalRecord,
          ),
        );
        return;
      }
      if (pendingError) {
        settleReject(pendingError);
        return;
      }
      const capturedStderr = redact(stderrCapture.text());
      const stderrTruncated = stderrCapture.truncated();
      if (capturedStderr) {
        try {
          // Stderr is intentionally published only after the bounded capture
          // can be redacted as one value. Per-chunk publication can leak a
          // credential split across adjacent child-process chunks.
          options.onStderr?.(capturedStderr);
        } catch {
          // Observability callbacks never own the child lifecycle.
        }
      }
      if (terminalMarked) {
        const initiatedCancellation = cancellationError(cancellationReason, capturedStderr, stderrTruncated);
        if (initiatedCancellation && terminalRecord?.type === "turn.cancelled") {
          settleReject(retainTerminal(initiatedCancellation, true, terminalRecord));
          return;
        }
        settleResolve({
          terminal: terminalRecord,
          exitCode: closeCode,
          signal: closeSignal,
          stderr: capturedStderr,
          stderrTruncated,
        });
        return;
      }
      const cancelled = cancellationError(cancellationReason, capturedStderr, stderrTruncated);
      if (cancelled) {
        settleReject(cancelled);
        return;
      }
      if (spawnErrorCode) {
        settleReject(
          processError("bridge_spawn_failed", `Could not start Nanocodex bridge (${spawnErrorCode}).`, {
            stderr: capturedStderr,
            stderrTruncated,
          }),
        );
        return;
      }
      if (!sawHello) {
        settleReject(
          processError("bridge_crashed", "Nanocodex bridge exited before hello.", {
            exitCode: closeCode,
            signal: closeSignal,
            stderr: capturedStderr,
            stderrTruncated,
          }),
        );
        return;
      }
      if (initialStartWriteFailed) {
        settleReject(crashError(closeCode, closeSignal, capturedStderr, stderrTruncated));
        return;
      }
      settleReject(
        closeCode !== 0 || closeSignal
          ? crashError(closeCode, closeSignal, capturedStderr, stderrTruncated)
          : processError("bridge_terminal_missing", "Nanocodex bridge exited without a terminal record.", {
              exitCode: closeCode,
              signal: closeSignal,
              stderr: capturedStderr,
              stderrTruncated,
            }),
      );
    }

    /** @param {RunNanocodexProcessResult} result */
    function settleResolve(result) {
      if (settled) return;
      settled = true;
      cleanupListeners();
      destroyChildStreams();
      resolve(result);
    }

    /** @param {Error} error */
    function settleReject(error) {
      if (settled) return;
      settled = true;
      cleanupListeners();
      destroyChildStreams();
      reject(error);
    }

    function destroyChildStreams() {
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (!child.stdout.destroyed) child.stdout.destroy();
      if (!child.stderr.destroyed) child.stderr.destroy();
    }

    child.stdin.on("error", onStdinError);
    child.stdout.on("data", onStdoutData);
    child.stdout.on("end", onStdoutEnd);
    child.stdout.on("error", onStdoutError);
    child.stderr.on("data", onStderrData);
    child.stderr.on("error", onStderrError);
    child.once("error", onChildError);
    child.once("close", onChildClose);

    try {
      options.onProcess?.({ phase: "started", pid: child.pid });
    } catch {
      // Observability callbacks never own the child lifecycle.
    }

    if (process.platform === "linux" && child.pid != null) {
      rootIdentity = readLinuxIdentity(child.pid);
      refreshDescendants(true);
      censusTimer = setInterval(() => refreshDescendants(true), 250);
      censusTimer.unref?.();
    }

    if (timeoutMs != null) {
      totalTimer = setTimeout(() => beginCancellation("timeout"), timeoutMs);
      totalTimer.unref?.();
    }
    resetIdleTimer();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

/**
 * Run provider-free capability discovery by spawning the bridge directly.
 * Success is reported only after the child has closed and every observed
 * descendant has been reaped or forcibly stopped. Child output and errors are
 * never copied into a thrown error.
 *
 * @param {{
 *   command: string;
 *   cwd: string;
 *   env: Record<string, string | undefined>;
 *   inheritEnv: boolean;
 *   timeoutMs?: number;
 *   maxOutputBytes?: number;
 *   maxStderrBytes?: number;
 *   signal?: AbortSignal;
 *   spawnFn?: typeof spawn;
 * }} options
 * @returns {Promise<Buffer>}
 */
export async function runNanocodexCapabilities(options) {
  if (!options || typeof options !== "object") throw new TypeError("Nanocodex capability options are required.");
  if (typeof options.command !== "string" || options.command.length === 0) {
    throw new TypeError("Nanocodex capability command must be a non-empty string.");
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new TypeError("Nanocodex capability cwd must be explicit.");
  }
  if (!options.env || typeof options.env !== "object" || Array.isArray(options.env)) {
    throw new TypeError("Nanocodex capability env must be explicit.");
  }
  if (typeof options.inheritEnv !== "boolean") {
    throw new TypeError("Nanocodex capability inheritEnv must be explicit.");
  }
  if (
    options.signal != null &&
    (typeof options.signal !== "object" ||
      typeof options.signal.aborted !== "boolean" ||
      typeof options.signal.addEventListener !== "function" ||
      typeof options.signal.removeEventListener !== "function")
  ) {
    throw new TypeError("Nanocodex capability signal must be AbortSignal-like.");
  }

  const timeoutMs = finiteTimerWithDefault(options.timeoutMs, 10_000, "timeoutMs");
  const maxOutputBytes = finiteNonNegativeInteger(options.maxOutputBytes, 1024 * 1024, "maxOutputBytes");
  const maxStderrBytes = finiteNonNegativeInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes");
  const effectiveEnv = normalizedEnvironment(options.env, options.inheritEnv);
  if (options.signal?.aborted) {
    throw processError("bridge_aborted", "Nanocodex capability preflight was aborted.", {
      reason: "aborted",
      stderr: "",
      stderrTruncated: false,
    });
  }
  const spawnSpec = createNanocodexSpawnSpec(options.command, ["capabilities", "--json"], effectiveEnv, options.cwd);

  return new Promise((resolvePromise, rejectPromise) => {
    const output = createBoundedBufferCapture(maxOutputBytes);
    const stderr = createBoundedCapture(maxStderrBytes);
    const descendants = new Map();
    let child;
    let childClosed = false;
    let settled = false;
    let pendingError;
    let spawnErrorCode;
    let rootIdentity;
    let timeoutTimer;
    let killTimer;
    let forceTimer;
    let censusTimer;
    let descendantCensusOverflow = false;

    const refreshDescendants = () => {
      if (process.platform !== "linux" || child?.pid == null) return;
      if (!rootIdentity && !childClosed) rootIdentity = readLinuxIdentity(child.pid);
      if (rootIdentity) {
        const census = censusLinuxDescendants(rootIdentity, descendants);
        if (census.overflow && !descendantCensusOverflow) {
          descendantCensusOverflow = true;
          beginFailure(
            processError(
              "bridge_cleanup_failed",
              `Nanocodex capability process exceeded the ${MAX_TRACKED_DESCENDANTS}-descendant cleanup census limit.`,
            ),
          );
        }
      }
    };

    const liveDescendants = () => {
      refreshDescendants();
      const live = [];
      for (const identity of descendants.values()) {
        if (sameLiveLinuxIdentity(identity)) live.push(identity);
        else descendants.delete(identity.pid);
      }
      return live;
    };

    /** @param {NodeJS.Signals} signal */
    const signalTree = (signal) => {
      refreshDescendants();
      for (const identity of liveDescendants()) {
        if (identity.pid === process.pid || !sameLiveLinuxIdentity(identity)) continue;
        try {
          process.kill(identity.pid, signal);
        } catch {
          // The observed descendant has already exited.
        }
      }
      if (!childClosed && rootIdentity && sameLinuxIdentity(rootIdentity)) {
        try {
          process.kill(-rootIdentity.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // The child exited during escalation.
          }
        }
      } else if (!childClosed && !rootIdentity) {
        try {
          child.kill(signal);
        } catch {
          // The child exited before its Linux identity could be read.
        }
      }
      refreshDescendants();
      for (const identity of liveDescendants()) {
        if (identity.pid === process.pid || !sameLiveLinuxIdentity(identity)) continue;
        try {
          process.kill(identity.pid, signal);
        } catch {
          // The descendant exited during the post-signal census.
        }
      }
    };

    const cleanupListeners = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      clearInterval(censusTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child?.stdout.removeAllListeners();
      child?.stderr.removeAllListeners();
      child?.removeAllListeners();
    };

    /** @param {Error} error */
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      rejectPromise(error);
    };

    /** @param {Buffer} value */
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      resolvePromise(value);
    };

    /** @param {Error} error */
    const beginFailure = (error) => {
      if (pendingError || childClosed || settled) return;
      pendingError = error;
      clearTimeout(timeoutTimer);
      signalTree("SIGTERM");
      killTimer = setTimeout(() => {
        signalTree("SIGKILL");
        forceTimer = setTimeout(() => {
          signalTree("SIGKILL");
          if (childClosed || settled) return;
          const survivingProcesses =
            (rootIdentity && sameLinuxIdentity(rootIdentity) ? 1 : 0) + liveDescendants().length;
          if (survivingProcesses > 0) {
            settleReject(
              processError("bridge_cleanup_failed", "Nanocodex capability processes survived forced cleanup.", {
                survivingProcesses,
                stderr: "",
                stderrTruncated: stderr.truncated(),
              }),
            );
            return;
          }
          onCapabilityClose(null, null);
        }, DEFAULT_KILL_WAIT_MS);
        forceTimer.unref?.();
      }, DEFAULT_TERM_GRACE_MS);
      killTimer.unref?.();
    };

    const onAbort = () => {
      beginFailure(
        processError("bridge_aborted", "Nanocodex capability preflight was aborted.", {
          reason: "aborted",
          stderr: "",
          stderrTruncated: false,
        }),
      );
    };

    const cleanupDescendants = async () => {
      let live = liveDescendants();
      if (live.length === 0) return !descendantCensusOverflow;
      signalTree("SIGTERM");
      await delay(DEFAULT_TERM_GRACE_MS);
      live = liveDescendants();
      if (live.length === 0) return !descendantCensusOverflow;
      const deadline = Date.now() + DEFAULT_KILL_WAIT_MS;
      while (Date.now() < deadline) {
        signalTree("SIGKILL");
        await delay(Math.min(20, Math.max(1, deadline - Date.now())));
        if (liveDescendants().length === 0) return !descendantCensusOverflow;
      }
      signalTree("SIGKILL");
      return liveDescendants().length === 0 && !descendantCensusOverflow;
    };

    try {
      const spawnFn = options.spawnFn ?? spawn;
      child = spawnFn(spawnSpec.command, spawnSpec.args, {
        cwd: options.cwd,
        env: effectiveEnv,
        shell: false,
        detached: process.platform === "linux",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      settleReject(spawnFailure(error));
      return;
    }

    const onStdoutData = (chunk) => {
      refreshDescendants();
      if (!output.append(chunk)) {
        beginFailure(processError("bridge_protocol_error", "Nanocodex capabilities exceeded the output limit."));
      }
    };
    const onStdoutError = () => {
      beginFailure(processError("bridge_capabilities_failed", "Could not read Nanocodex capability stdout."));
    };
    const onStderrData = (chunk) => {
      stderr.append(chunk);
      refreshDescendants();
    };
    const onStderrError = () => {
      beginFailure(processError("bridge_capabilities_failed", "Could not read Nanocodex capability stderr."));
    };
    child.stdout.on("data", onStdoutData);
    child.stdout.on("error", onStdoutError);
    child.stderr.on("data", onStderrData);
    child.stderr.on("error", onStderrError);
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      spawnErrorCode = typeof error.code === "string" ? error.code : "SPAWN_FAILED";
    });
    /**
     * @param {number | null} code
     * @param {NodeJS.Signals | null} signal
     */
    const onCapabilityClose = (code, signal) => {
      if (childClosed) return;
      childClosed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      void (async () => {
        const rootSurvived = rootIdentity ? sameLinuxIdentity(rootIdentity) : false;
        const descendantsClosed = await cleanupDescendants();
        if (rootSurvived || !descendantsClosed) {
          settleReject(
            processError("bridge_cleanup_failed", "Nanocodex capability process cleanup could not be verified.", {
              stderr: "",
              stderrTruncated: stderr.truncated(),
            }),
          );
          return;
        }
        if (pendingError) {
          settleReject(pendingError);
          return;
        }
        if (spawnErrorCode) {
          settleReject(spawnFailure({ code: spawnErrorCode }));
          return;
        }
        if (code !== 0 || signal) {
          settleReject(
            processError("bridge_capabilities_failed", "Nanocodex capability preflight failed.", {
              exitCode: code,
              signal,
              stderr: "",
              stderrTruncated: stderr.truncated(),
            }),
          );
          return;
        }
        settleResolve(output.value());
      })();
    };
    child.once("close", onCapabilityClose);

    if (process.platform === "linux" && child.pid != null) {
      rootIdentity = readLinuxIdentity(child.pid);
      refreshDescendants();
      censusTimer = setInterval(refreshDescendants, 50);
      censusTimer.unref?.();
    }
    child.stdin.end();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    timeoutTimer = setTimeout(
      () => beginFailure(processError("bridge_capabilities_timeout", "Nanocodex capability preflight timed out.")),
      timeoutMs,
    );
    timeoutTimer.unref?.();
  });
}

/**
 * Resolve the bridge executable and return a direct spawn spec. Protocol data
 * and credentials remain on stdin/environment; argv contains only the binary
 * and non-secret switches.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {Record<string, string | undefined>} [environment]
 * @param {string} [cwd]
 */
export function createNanocodexSpawnSpec(command, args = [], environment = process.env, cwd = process.cwd()) {
  return {
    command: resolveNanocodexExecutable(command, cwd, environment),
    args: [...args],
  };
}

/**
 * Resolve the bridge from an absolute path, cwd-relative path, or explicit PATH.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {Record<string, string | undefined>} environment
 */
export function resolveNanocodexExecutable(command, cwd, environment) {
  const candidates = [];
  if (isAbsolute(command)) {
    candidates.push(command);
  } else if (command.includes("/")) {
    candidates.push(resolve(cwd, command));
  } else if (typeof environment.PATH === "string") {
    for (const directory of environment.PATH.split(delimiter)) {
      candidates.push(resolvePathCandidate(directory, cwd, command));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return realpathSync(candidate);
    } catch {
      // Continue through explicit PATH candidates without exposing them.
    }
  }
  throw processError("bridge_spawn_failed", "Nanocodex bridge executable could not be resolved.", {
    stderr: "",
    stderrTruncated: false,
  });
}

/** @param {RunNanocodexProcessOptions} options */
function assertOptions(options) {
  if (!options || typeof options !== "object") throw new TypeError("Nanocodex process options are required.");
  if (typeof options.command !== "string" || options.command.length === 0) {
    throw new TypeError("Nanocodex process command must be a non-empty string.");
  }
  if (options.args != null && (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== "string"))) {
    throw new TypeError("Nanocodex process args must be a string array when supplied.");
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new TypeError("Nanocodex process cwd must be explicit.");
  }
  if (!options.env || typeof options.env !== "object" || Array.isArray(options.env)) {
    throw new TypeError("Nanocodex process env must be explicit.");
  }
  if (typeof options.inheritEnv !== "boolean") {
    throw new TypeError("Nanocodex process inheritEnv must be explicit.");
  }
  if (typeof options.validateRecord !== "function") {
    throw new TypeError("Nanocodex process validateRecord callback is required.");
  }
  if (typeof options.isHello !== "function") {
    throw new TypeError("Nanocodex process isHello callback is required.");
  }
  if (typeof options.onHello !== "function") {
    throw new TypeError("Nanocodex process onHello callback is required.");
  }
  if (options.onRecord != null && typeof options.onRecord !== "function") {
    throw new TypeError("Nanocodex process onRecord must be a function.");
  }
  if (options.onCancel != null && typeof options.onCancel !== "function") {
    throw new TypeError("Nanocodex process onCancel must be a function.");
  }
  if (options.onStderr != null && typeof options.onStderr !== "function") {
    throw new TypeError("Nanocodex process onStderr must be a function.");
  }
  if (options.onProcess != null && typeof options.onProcess !== "function") {
    throw new TypeError("Nanocodex process onProcess must be a function.");
  }
  if (options.spawnFn != null && typeof options.spawnFn !== "function") {
    throw new TypeError("Nanocodex process spawnFn must be a function.");
  }
  if (options.killFn != null && typeof options.killFn !== "function") {
    throw new TypeError("Nanocodex process killFn must be a function.");
  }
  if (
    options.signal != null &&
    (typeof options.signal !== "object" ||
      typeof options.signal.aborted !== "boolean" ||
      typeof options.signal.addEventListener !== "function" ||
      typeof options.signal.removeEventListener !== "function")
  ) {
    throw new TypeError("Nanocodex process signal must be AbortSignal-like.");
  }
}

/**
 * @param {Record<string, string | undefined>} overrides
 * @param {boolean} inherit
 */
function normalizedEnvironment(overrides, inherit) {
  const source = inherit ? { ...process.env, ...overrides } : overrides;
  return Object.fromEntries(Object.entries(source).filter((entry) => typeof entry[1] === "string"));
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @param {string} name
 */
function finiteNonNegativeInteger(value, fallback, name) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative safe integer.`);
  }
  return value;
}

/** @param {number} value @param {string} name */
function finiteTimer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RUNTIME_DELAY_MS) {
    throw new TypeError(`${name} must be a finite non-negative safe integer no greater than ${MAX_RUNTIME_DELAY_MS}.`);
  }
  return value;
}

/** @param {number | undefined} value @param {number} fallback @param {string} name */
function finiteTimerWithDefault(value, fallback, name) {
  return finiteTimer(value ?? fallback, name);
}

/** @param {number | undefined} value @param {string} name */
function optionalFiniteTimer(value, name) {
  return value == null ? undefined : finiteTimer(value, name);
}

/** @param {number} maxBytes */
function createBoundedCapture(maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    /** @param {Buffer} chunk */
    append(chunk) {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        chunks.push(captured);
        bytes += captured.byteLength;
      }
      if (chunk.byteLength > remaining) truncated = true;
    },
    text: () => Buffer.concat(chunks, bytes).toString("utf8"),
    truncated: () => truncated,
  };
}

/** @param {number} maxBytes */
function createBoundedBufferCapture(maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  return {
    /** @param {Buffer} chunk */
    append(chunk) {
      if (bytes + chunk.byteLength > maxBytes) return false;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      return true;
    },
    value: () => Buffer.concat(chunks, bytes),
  };
}

/**
 * @param {number} maxBytes
 */
function createStderrSuppressor(maxBytes) {
  return (value) => {
    if (!value) return "";
    // Arbitrary child stderr cannot be safely redacted after chunking and
    // truncation: even a known credential can be cut to an unrecognizable
    // prefix. JSON terminal errors are authoritative, so catastrophic stderr
    // is represented only by a fixed marker.
    return truncateUtf8("[Nanocodex bridge stderr content suppressed]", maxBytes);
  };
}

/** @param {string} value @param {number} maxBytes */
function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  return `${buffer.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8")}...`;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function processError(code, message, details = {}) {
  const error = new Error(truncateUtf8(message, 8 * 1024));
  error.name = "NanocodexProcessError";
  Object.assign(error, { code, ...details });
  return error;
}

/** @param {string} message */
function stdinWriteError(message) {
  const error = processError("bridge_input_error", message);
  Object.defineProperty(error, STDIN_WRITE_FAILURE, { value: true });
  return error;
}

/** @param {Error} error @param {boolean} terminalMarked @param {unknown} terminal */
function retainTerminal(error, terminalMarked, terminal) {
  if (terminalMarked) {
    Object.defineProperty(error, "terminal", { configurable: true, value: terminal });
  }
  return error;
}

/** @param {unknown} error */
function spawnFailure(error) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "SPAWN_FAILED";
  return processError("bridge_spawn_failed", `Could not start Nanocodex bridge (${code}).`, {
    stderr: "",
    stderrTruncated: false,
  });
}

/** @param {string} message */
function protocolError(message) {
  return processError("bridge_protocol_error", message);
}

/**
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @param {string} stderr
 * @param {boolean} stderrTruncated
 */
function crashError(code, signal, stderr, stderrTruncated) {
  const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  const excerpt = truncateUtf8(stderr.trim(), MAX_CRASH_STDERR_BYTES);
  return processError(
    "bridge_crashed",
    `Nanocodex bridge crashed (${status}).${excerpt ? ` Stderr: ${excerpt}` : ""}`,
    { exitCode: code, signal, stderr, stderrTruncated },
  );
}

/**
 * @param {NanocodexCancellationReason | undefined} reason
 * @param {string} stderr
 * @param {boolean} stderrTruncated
 */
function cancellationError(reason, stderr, stderrTruncated) {
  if (!reason) return undefined;
  const values = {
    aborted: ["bridge_aborted", "Nanocodex bridge was aborted."],
    timeout: ["bridge_timeout", "Nanocodex bridge exceeded its total timeout."],
    idle_timeout: ["bridge_idle_timeout", "Nanocodex bridge exceeded its idle timeout."],
  };
  const [code, message] = values[reason];
  return processError(code, message, { reason, stderr, stderrTruncated });
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Wait for an arbitrary callback only within an existing lifecycle bound.
 * Rejection counts as settlement; callers retain process cleanup authority.
 * @param {Promise<unknown>} promise
 * @param {number} milliseconds
 */
function settleWithin(promise, milliseconds) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (settled) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    Promise.resolve(promise).then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/** @param {number} pid */
function readLinuxIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (!startTime) return undefined;
    return { pid, startTime, state: fields[0] };
  } catch {
    return undefined;
  }
}

/** @param {{ pid: number; startTime: string }} identity */
function sameLinuxIdentity(identity) {
  const current = readLinuxIdentity(identity.pid);
  return current?.startTime === identity.startTime;
}

/** A zombie has no executable descendants or live resources to supervise. */
function sameLiveLinuxIdentity(identity) {
  const current = readLinuxIdentity(identity.pid);
  return current?.startTime === identity.startTime && current.state !== "Z" && current.state !== "X";
}

/**
 * Census every currently known process tree exactly once. Cached live
 * identities remain roots so a detached/reparented process stays supervised.
 * Linux records children under the task that created them, so every task's
 * children file is enumerated rather than only the thread-group leader's.
 *
 * @param {{ pid: number; startTime: string }} root
 * @param {Map<number, { pid: number; startTime: string }>} output
 * @returns {{ overflow: boolean }}
 */
function censusLinuxDescendants(root, output) {
  for (const identity of output.values()) {
    if (!sameLiveLinuxIdentity(identity)) output.delete(identity.pid);
  }

  const queue = [root, ...output.values()];
  const visited = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const identityKey = `${current.pid}:${current.startTime}`;
    if (visited.has(identityKey) || !sameLiveLinuxIdentity(current)) continue;
    visited.add(identityKey);

    for (const childPid of readLinuxTaskChildren(current)) {
      const identity = readLinuxIdentity(childPid);
      if (!identity || identity.pid === process.pid) continue;
      const known = output.get(identity.pid);
      if (known && known.startTime !== identity.startTime) output.delete(identity.pid);
      if (!output.has(identity.pid)) {
        if (output.size >= MAX_TRACKED_DESCENDANTS) return { overflow: true };
        output.set(identity.pid, identity);
      }
      const childKey = `${identity.pid}:${identity.startTime}`;
      if (!visited.has(childKey)) queue.push(identity);
    }
  }
  return { overflow: false };
}

/** @param {{ pid: number; startTime: string }} identity */
function readLinuxTaskChildren(identity) {
  if (!sameLiveLinuxIdentity(identity)) return [];
  let tasks;
  try {
    tasks = readdirSync(`/proc/${identity.pid}/task`);
  } catch {
    return [];
  }
  const children = new Set();
  for (const task of tasks) {
    if (!/^\d+$/.test(task)) continue;
    try {
      const contents = readFileSync(`/proc/${identity.pid}/task/${task}/children`, "utf8");
      for (const rawPid of contents.trim().split(/\s+/)) {
        if (rawPid) children.add(Number(rawPid));
      }
    } catch {
      // The task exited while its children were being enumerated.
    }
  }
  // Do not trust a multi-task scan across PID reuse.
  return sameLiveLinuxIdentity(identity) ? [...children] : [];
}

/** @param {string} directory @param {string} cwd @param {string} command */
function resolvePathCandidate(directory, cwd, command) {
  const base = directory === "" ? cwd : isAbsolute(directory) ? directory : resolve(cwd, directory);
  return resolve(base, command);
}

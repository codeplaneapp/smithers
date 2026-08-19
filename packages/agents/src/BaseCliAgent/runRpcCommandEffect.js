import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Effect, Metric } from "effect";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { logDebug, logWarning } from "@smthrs/observability/logging";
import { toolOutputTruncatedTotal } from "@smthrs/observability/metrics";
import { extractTextFromJsonValue } from "./extractTextFromJsonValue.js";
import { normalizeTokenUsage } from "./normalizeTokenUsage.js";
import { parentDeathCommand } from "./parentDeathCommand.js";
import { truncateToBytes } from "./truncateToBytes.js";
import { sanitizeCliArgs, sanitizeCliErrorCause } from "./sanitizeCliArgs.js";
/** @typedef {import("./PiExtensionUiResponse.ts").PiExtensionUiResponse} PiExtensionUiResponse */

/** @typedef {import("./PiExtensionUiRequest.ts").PiExtensionUiRequest} PiExtensionUiRequest */
/**
 * @typedef {{ cwd: string; env: Record<string, string>; prompt: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined; exitCode?: number | null; signal?: string | null }) => void; onJsonEvent?: (event: Record<string, unknown>) => Promise<void> | void; onExtensionUiRequest?: (request: PiExtensionUiRequest) => Promise<PiExtensionUiResponse | null> | PiExtensionUiResponse | null; spawnFn?: typeof spawn; }} RunRpcCommandOptions
 */

/**
 * @param {number | undefined} timeoutMs
 * @param {() => void} onTimeout
 */
function createOneShotTimer(timeoutMs, onTimeout) {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return { clear: () => {} };
  }
  const timer = setTimeout(onTimeout, timeoutMs);
  return {
    clear: () => clearTimeout(timer),
  };
}
/**
 * @param {number | undefined} timeoutMs
 * @param {() => void} onTimeout
 */
function createInactivityTimer(timeoutMs, onTimeout) {
  let timer;
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return {
      reset: () => {},
      clear: () => {},
    };
  }
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTimeout, timeoutMs);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  reset();
  return { reset, clear };
}
/**
 * Normalize CLI usage into the AI SDK shape consumed by Smithers telemetry.
 * @param {unknown} value
 * @returns {import("../GenerateResult.ts").LanguageModelUsage | undefined}
 */
function toLanguageModelUsage(value) {
  const usage = normalizeTokenUsage(value);
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: usage.reasoningTokens,
    },
    totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined),
  };
}
/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunRpcCommandOptions} options
 * @returns {Effect.Effect<{ text: string; output: unknown; stderr: string; exitCode: number | null; usage?: any; }, SmithersError>}
 */
export function runRpcCommandEffect(command, args, options) {
  const {
    cwd,
    env,
    prompt,
    timeoutMs,
    idleTimeoutMs,
    signal,
    maxOutputBytes,
    onStdout,
    onStderr,
    onProcess,
    onJsonEvent,
    onExtensionUiRequest,
    spawnFn = spawn,
  } = options;
  const safeArgs = sanitizeCliArgs(args);
  const span = `agent:${command}:rpc`;
  const logAnnotations = {
    agentCommand: command,
    agentArgs: safeArgs.join(" "),
    cwd,
    rpc: true,
    timeoutMs: timeoutMs ?? null,
    idleTimeoutMs: idleTimeoutMs ?? null,
  };
  return Effect.callback((resume) => {
    let stderr = "";
    let settled = false;
    let exitCode = null;
    let textDeltas = "";
    let streamedAnyText = false;
    let finalMessage = null;
    let promptResponseError = null;
    let extractedUsage = undefined;
    let stderrTruncated = false;
    let terminationStarted = false;
    logDebug("starting agent RPC command", logAnnotations, span);
    const invocation = parentDeathCommand(command, args, spawnFn === spawn, cwd);
    const child = spawnFn(invocation.command, invocation.args, {
      // See runCommandEffect: the watchdog must not boot inside the agent's cwd.
      cwd: invocation.cwd ?? cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onProcess?.({ phase: "started", pid: child.pid });
    let processExited = false;
    /**
     * @param {number | null} [notifiedExitCode]
     * @param {string | null} [notifiedSignal]
     */
    const notifyProcessExited = (notifiedExitCode = null, notifiedSignal = null) => {
      if (processExited) return;
      processExited = true;
      onProcess?.({ phase: "exited", pid: child.pid, exitCode: notifiedExitCode, signal: notifiedSignal });
    };
    child.unref();
    // A fast-exiting or early-closing child can make writes to stdin emit an
    // async EPIPE/ECONNRESET. Without a listener Node escalates it to an
    // uncaught exception that tears down the whole orchestrator process.
    child.stdin?.on("error", () => {});
    const rl = createInterface({ input: child.stdout });
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [details]
     * @param {unknown} [cause]
     */
    const makeAgentCliError = (message, details, cause) =>
      new SmithersError(
        "AGENT_CLI_ERROR",
        message,
        {
          agentArgs: safeArgs,
          agentCommand: command,
          cwd,
          ...details,
        },
        { cause },
      );
    /**
     * @param {SmithersError} err
     */
    const handleError = (err, message = "agent RPC command failed") => {
      if (settled) return;
      settled = true;
      inactivity.clear();
      totalTimeout.clear();
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      if (!processExited) {
        terminateChild();
      }
      notifyProcessExited();
      logWarning(
        message,
        {
          ...logAnnotations,
          error: err.message,
        },
        span,
      );
      try {
        rl.close();
      } catch {
        // ignore
      }
      resume(Effect.fail(err));
    };
    /**
     * @param {string} text
     * @param {unknown} output
     */
    const finalize = (text, output) => {
      if (settled) return;
      settled = true;
      inactivity.clear();
      totalTimeout.clear();
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      notifyProcessExited();
      logDebug(
        "agent RPC command completed",
        {
          ...logAnnotations,
          exitCode: child.exitCode ?? exitCode,
          stderrBytes: Buffer.byteLength(stderr, "utf8"),
          textBytes: Buffer.byteLength(text, "utf8"),
        },
        span,
      );
      try {
        rl.close();
      } catch {
        // ignore
      }
      resume(
        Effect.succeed({ text, output, stderr, exitCode: child.exitCode, usage: toLanguageModelUsage(extractedUsage) }),
      );
    };
    /**
     * @param {NodeJS.Signals} signal
     */
    const killProcessGroup = (signal) => {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the direct child when the detached group
          // is not observable yet.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // process already exited
      }
    };
    const terminateChild = () => {
      if (!child.pid || terminationStarted) return;
      terminationStarted = true;
      killProcessGroup("SIGTERM");
      const killTimer = setTimeout(() => {
        killProcessGroup("SIGKILL");
      }, 250);
      child.once("close", () => clearTimeout(killTimer));
    };
    /**
     * @param {string} reason
     */
    let abortSent = false;
    const sendAbort = () => {
      if (command !== "omp" || abortSent || !child.stdin || child.stdin.destroyed) return;
      abortSent = true;
      try {
        child.stdin.write(`${JSON.stringify({ id: randomUUID(), type: "abort" })}\n`, () => {});
      } catch {
        // The process may already have closed stdin; forced cleanup below remains authoritative.
      }
    };
    const kill = (reason) => {
      sendAbort();
      terminateChild();
      handleError(makeAgentCliError(reason), "agent RPC command interrupted");
    };
    const totalTimeout = createOneShotTimer(timeoutMs, () => kill(`CLI timed out after ${timeoutMs}ms`));
    const inactivity = createInactivityTimer(idleTimeoutMs, () => kill(`CLI idle timed out after ${idleTimeoutMs}ms`));
    function onAbort() {
      kill("CLI aborted");
    }
    if (signal?.aborted) {
      onAbort();
    } else if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", onAbort);
        onAbort();
      }
    }
    /**
     * @param {PiExtensionUiRequest} request
     */
    const maybeWriteExtensionResponse = async (request) => {
      const needsResponse = ["select", "confirm", "input", "editor"].includes(request.method);
      if (!needsResponse && !onExtensionUiRequest) return;
      let response = onExtensionUiRequest ? await onExtensionUiRequest(request) : null;
      if (!response && needsResponse) {
        response = { type: "extension_ui_response", id: request.id, cancelled: true };
      }
      if (!response) return;
      const normalized = { ...response, id: request.id, type: "extension_ui_response" };
      if (!child.stdin) {
        handleError(makeAgentCliError("Failed to send extension UI response: child stdin is not available"));
        terminateChild();
        return;
      }
      child.stdin.write(`${JSON.stringify(normalized)}\n`, () => {});
    };
    /**
     * @param {string} line
     */
    const handleLine = async (line) => {
      inactivity.reset();
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed;
      void Promise.resolve(onJsonEvent?.(event)).catch(() => undefined);
      const type = event.type;
      if (command === "omp" && type === "ready") sendPrompt();
      if (type === "response" && event.command === "prompt" && event.success === false) {
        const errorMessage = typeof event.error === "string" ? event.error : "PI RPC prompt failed";
        promptResponseError = errorMessage;
        kill(errorMessage);
        return;
      }
      if (type === "message_update") {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
          textDeltas += assistantEvent.delta;
          streamedAnyText = true;
          onStdout?.(assistantEvent.delta);
        }
      }
      if (type === "message_end") {
        const message = event.message;
        if (message?.role === "assistant") {
          finalMessage = event.message;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
          }
        }
      }
      if (event.usage) {
        extractedUsage = event.usage;
      }
      const localPromptCompletion =
        type === "response" &&
        event.command === "prompt" &&
        event.success === true &&
        event.data?.agentInvoked === false;
      if (type === "turn_end" || type === "agent_end" || type === "prompt_result" || localPromptCompletion) {
        const message =
          event.message ??
          (Array.isArray(event.messages) ? event.messages.findLast((value) => value?.role === "assistant") : undefined);
        if (message?.role === "assistant") {
          finalMessage = message;
          if (message.usage) extractedUsage = message.usage;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
          }
          const extracted = finalMessage ? extractTextFromJsonValue(finalMessage) : undefined;
          const text = extracted ?? textDeltas;
          if (!streamedAnyText && text) {
            onStdout?.(text);
          }
          inactivity.clear();
          totalTimeout.clear();
          if (promptResponseError) {
            handleError(makeAgentCliError(promptResponseError));
            return;
          }
          finalize(text, finalMessage ?? text);
          child.stdin?.end();
          terminateChild();
        } else if (type === "agent_end" || type === "prompt_result" || localPromptCompletion) {
          inactivity.clear();
          totalTimeout.clear();
          finalize(textDeltas, finalMessage ?? textDeltas);
          child.stdin?.end();
          terminateChild();
        }
      }
      if (type === "extension_ui_request") {
        await maybeWriteExtensionResponse(event);
      }
    };
    let lineQueue = Promise.resolve();
    rl.on("line", (line) => {
      // Once the effect has settled its timers are cleared; a late line
      // must not re-arm the inactivity timer (handleLine calls reset()).
      if (settled) return;
      lineQueue = lineQueue
        .then(() => handleLine(line))
        .catch((err) => {
          handleError(
            err instanceof SmithersError ? err : toSmithersError(err, undefined, { code: "AGENT_CLI_ERROR" }),
          );
        });
    });
    child.stdout?.on("data", () => {
      // A data event that arrives after settlement would otherwise re-arm
      // (and leak) the inactivity timer past the cleared() settle path.
      if (settled) return;
      inactivity.reset();
    });
    child.stderr?.on("data", (chunk) => {
      if (settled) return;
      inactivity.reset();
      const text = chunk.toString("utf8");
      const nextStderr = stderr + text;
      if (!stderrTruncated && maxOutputBytes && Buffer.byteLength(nextStderr, "utf8") > maxOutputBytes) {
        stderrTruncated = true;
        void Effect.runPromise(Metric.update(toolOutputTruncatedTotal, 1));
        logWarning(
          "agent RPC stderr truncated",
          {
            ...logAnnotations,
            maxOutputBytes,
          },
          span,
        );
      }
      stderr = truncateToBytes(nextStderr, maxOutputBytes);
      onStderr?.(text);
    });
    // The RPC child's OS-level exit is liveness truth even when the JSON-RPC
    // stream never produces a terminal message (#1582).
    child.on("exit", (code, signal) => {
      notifyProcessExited(code ?? null, signal ?? null);
    });
    child.on("error", (err) => {
      inactivity.clear();
      totalTimeout.clear();
      handleError(
        toSmithersError(sanitizeCliErrorCause(err), undefined, {
          code: "AGENT_CLI_ERROR",
          details: {
            agentArgs: safeArgs,
            agentCommand: command,
            cwd,
          },
        }),
      );
    });
    child.on("close", (code, signal) => {
      notifyProcessExited(code ?? null, signal ?? null);
      exitCode = code ?? null;
      inactivity.clear();
      totalTimeout.clear();
      if (settled) return;
      if (promptResponseError) {
        handleError(makeAgentCliError(promptResponseError));
        return;
      }
      if (code && code !== 0) {
        handleError(makeAgentCliError(stderr.trim() || `CLI exited with code ${code}`));
        return;
      }
      const text = finalMessage ? (extractTextFromJsonValue(finalMessage) ?? textDeltas) : textDeltas;
      if (!streamedAnyText && text) {
        onStdout?.(text);
      }
      finalize(text ?? "", finalMessage ?? text ?? "");
    });
    const promptPayload = { id: randomUUID(), type: "prompt", message: prompt };
    const statePayload = { id: randomUUID(), type: "get_state" };
    let ompStarted = command === "omp";
    const sendPrompt = () => {
      if (!child.stdin || !ompStarted) return;
      child.stdin.write(`${JSON.stringify(statePayload)}\n`, () => {});
      child.stdin.write(`${JSON.stringify(promptPayload)}\n`, () => {});
      ompStarted = false;
    };
    if (!child.stdin) {
      handleError(makeAgentCliError("Child process stdin is not available; cannot send prompt payload."));
      return;
    }
    if (command === "omp") {
      // OMP v17 emits a ready record before accepting commands.
      // The line handler below sends the correlated state/prompt pair.
    } else {
      child.stdin.write(`${JSON.stringify(promptPayload)}\n`, () => {});
    }
    return Effect.sync(() => {
      try {
        rl.close();
      } catch {
        // ignore
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      killProcessGroup("SIGKILL");
    });
  }).pipe(Effect.annotateLogs(logAnnotations), Effect.withLogSpan(span));
}

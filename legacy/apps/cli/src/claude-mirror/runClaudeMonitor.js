import { claudeMirrorContract } from "./claudeMirrorContract.js";
import { isTerminalClaudeMirrorRunStatus } from "./isTerminalClaudeMirrorRunStatus.js";
import { readClaudeMirrorSubscriptions } from "./readClaudeMirrorSubscriptions.js";
import { removeClaudeMirrorSubscription } from "./removeClaudeMirrorSubscription.js";
import { isPidAlive, parseRuntimeOwnerPid } from "@smthrs/engine/runtime-owner";

const RUN_SCAN_LIMIT = 50;
const EVENT_PAGE_SIZE = 200;

const NOTABLE_EVENT_KINDS = new Map([
  ["ApprovalRequested", "approval-pending"],
  ["RunFailed", "run-failed"],
  ["RunFinished", "run-finished"],
  ["RunCancelled", "run-cancelled"],
  ["RunCanceled", "run-cancelled"],
  ["RunContinuedAsNew", "run-continued"],
]);

const TERMINAL_STATUS_KINDS = new Map([
  ["failed", "run-failed"],
  ["finished", "run-finished"],
  ["cancelled", "run-cancelled"],
  ["canceled", "run-cancelled"],
  ["continued", "run-continued"],
]);

// FYI-only transitions. The store is shared by every session in a workspace,
// so broadcasting these wakes every session for every other session's runs;
// a run this session actually follows already reports completion through its
// /workflows mirror. Suppressed unless `transitions: "all"`.
const FYI_KINDS = new Set(["run-finished", "run-cancelled", "run-continued"]);

/**
 * NDJSON follower behind the Claude Code plugin's background monitor: one line
 * per notable transition, each with the resolving command. By default only
 * actionable transitions stream (approval pending, human request, run failed,
 * stalled heartbeat, retry churn, progress digest); pass `transitions: "all"`
 * to also stream the FYI ones (finished, cancelled, continued). History before
 * the monitor started is not replayed; already-pending approvals and human
 * requests are surfaced once at startup.
 *
 * Silence is itself a failure mode (issue #1413): a detached run can stay
 * alive for hours while nodes grind through retries, crossing no failed or
 * stalled transition, so a host agent driven by this stream had nothing to
 * relay and the user could not tell churn from health. Two signals make that
 * impossible: `node-retrying` fires when an active attempt reaches
 * `retryAlertAttempt` (re-firing on each later attempt), and `run-progress`
 * fires whenever a followed non-terminal run has produced no monitor line for
 * `progressEveryMs`, so no followed run is ever silent longer than one digest
 * window.
 *
 * With `subscriptionsPath` set the monitor follows ONLY subscribed runs (the
 * ones this session started or attached a mirror to, recorded by `claude
 * tick`/`claude subscribe`), filtered to `sessionId` (entries with a null
 * sessionId always match, and a monitor without a sessionId matches every
 * entry). The store is shared by every session in a workspace, so scanning
 * all runs would wake each session for every other session's — and every
 * pre-existing — run. Without `subscriptionsPath` it scans all local runs.
 *
 * A run counts as stalled only when its heartbeat is older than
 * `stalledAfterMs` AND no new events or task-heartbeat rows were persisted
 * within that window. Task-heartbeat rows are durable evidence from the
 * fenced task owner, so they remain valid when the run-heartbeat timer is
 * starved by a long-running child process.
 *
 * @param {any} adapter
 * @param {{ intervalMs?: number; stalledAfterMs?: number; retryAlertAttempt?: number; progressEveryMs?: number; ticks?: number; transitions?: "actionable" | "all"; subscriptionsPath?: string; sessionId?: string; write?: (line: string) => void; now?: () => number }} [options]
 */
export async function runClaudeMonitor(adapter, options = {}) {
  const intervalMs = Math.max(250, Math.floor(options.intervalMs ?? 2000));
  const stalledAfterMs = Math.max(5000, Math.floor(options.stalledAfterMs ?? 120000));
  const retryAlertAttempt =
    options.retryAlertAttempt === 0 ? 0 : Math.max(2, Math.floor(options.retryAlertAttempt ?? 3));
  const progressEveryMs =
    options.progressEveryMs === 0 ? 0 : Math.max(60000, Math.floor(options.progressEveryMs ?? 1800000));
  const allTransitions = options.transitions === "all";
  const subscriptionsPath = options.subscriptionsPath;
  const sessionId = options.sessionId;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;

  /** @type {Map<string, number>} cursor per run */
  const cursors = new Map();
  /** @type {Set<string>} emitted dedup keys */
  const emitted = new Set();
  /** @type {Set<string>} runs currently flagged stalled */
  const stalledRuns = new Set();
  /** @type {Set<string>} runs for which cancellation was durably observed */
  const cancellationObserved = new Set();
  /** @type {Map<string, number>} last time NEW persisted events were observed per run */
  const eventActivityAt = new Map();
  /** @type {Map<string, number>} newest persisted active-task heartbeat observed per run */
  const taskHeartbeatActivityAt = new Map();
  /** @type {Set<string>} terminal runs that already got their final scan */
  const finalScanned = new Set();
  /** @type {Map<string, number>} last time ANY line was written per run — the run-progress silence clock */
  const lastLineAt = new Map();

  /** @param {Record<string, unknown>} entry */
  const emit = (entry) => {
    if (typeof entry.runId === "string") {
      lastLineAt.set(entry.runId, now());
    }
    write(JSON.stringify({ contract: claudeMirrorContract, ts: now(), ...entry }));
  };

  /** @param {string} key @param {Record<string, unknown>} entry */
  const emitOnce = (key, entry) => {
    if (emitted.has(key)) {
      return;
    }
    emitted.add(key);
    emit(entry);
  };

  let tick = 0;
  while (options.ticks === undefined || tick < options.ticks) {
    tick += 1;
    const runs =
      subscriptionsPath === undefined
        ? await Promise.resolve(adapter.listRuns(RUN_SCAN_LIMIT)).catch(() => [])
        : await listSubscribedRuns(adapter, subscriptionsPath, sessionId, now());
    for (const run of runs) {
      const runId = run.runId;
      if (!cursors.has(runId)) {
        // First sight: skip history, but surface anything already waiting.
        const newest = await Promise.resolve(adapter.getLastEventSeq(runId)).catch(() => undefined);
        cursors.set(runId, typeof newest === "number" ? newest : 0);
        if (isTerminalClaudeMirrorRunStatus(run.status)) {
          // Already over when we first saw it: pure pre-monitor history,
          // never replayed and never synthesized below.
          finalScanned.add(runId);
          if (subscriptionsPath !== undefined) {
            removeClaudeMirrorSubscription(subscriptionsPath, { runId, nowMs: now() });
          }
        } else {
          // The silence clock starts at first sight, not at run creation, so
          // a monitor attaching to an old run does not fire an instant digest.
          lastLineAt.set(runId, now());
          await emitPendingGates(adapter, runId, emitOnce);
        }
        continue;
      }
      const finalScan = isTerminalClaudeMirrorRunStatus(run.status);
      if (finalScan) {
        // One final scan so the RunFinished/RunFailed line is not lost
        // to the race between the status flip and the last event read.
        if (finalScanned.has(runId)) {
          continue;
        }
        finalScanned.add(runId);
      }
      let cursor = cursors.get(runId) ?? 0;
      const cursorAtScanStart = cursor;
      let sawTerminalEvent = false;
      let eventReadFailed = false;
      let newestPersistedEventAtMs;
      // Live runs read one page per tick (the cursor catches up next tick).
      // The final scan of a terminal run must drain every remaining page:
      // a failing run can flush a >EVENT_PAGE_SIZE burst of trailing events
      // in one polling window, hiding the RunFailed row past the first page
      // of the only read this run will ever get again.
      for (;;) {
        const pageStart = cursor;
        let rows = [];
        try {
          rows = await Promise.resolve(adapter.listEventHistory(runId, { afterSeq: cursor, limit: EVENT_PAGE_SIZE }));
        } catch {
          // A failed evidence read is inconclusive. It must not be
          // converted into a false stalled verdict.
          eventReadFailed = true;
          break;
        }
        for (const row of rows) {
          const persistedAtMs = Number(row.timestampMs ?? row.createdAtMs);
          if (Number.isFinite(persistedAtMs)) {
            newestPersistedEventAtMs = Math.max(newestPersistedEventAtMs ?? 0, persistedAtMs);
          }
          const seq = Number(row.seq ?? 0);
          if (seq > cursor) {
            cursor = seq;
          }
          const type = String(row.type ?? "");
          const kind = NOTABLE_EVENT_KINDS.get(type);
          if (!kind) {
            continue;
          }
          const payload = parsePayload(row.payloadJson);
          if (kind === "approval-pending") {
            if (finalScan || isTerminalClaudeMirrorRunStatus(run.status)) {
              continue;
            }
            // The request event and terminal run status are separate
            // durable rows. Re-read immediately before publishing so
            // cancellation cannot turn a just-read request into a ghost.
            const beforeApprovalEmit = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
            if (beforeApprovalEmit && isTerminalClaudeMirrorRunStatus(beforeApprovalEmit.status)) {
              continue;
            }
            // Dedupe against emitPendingGates (below), which surfaces the
            // same still-pending gate each tick. Use the identical key so a
            // gate requested while we are watching a run is announced once,
            // not twice (event-log line + pending-gates line).
            const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : "";
            const iteration = typeof payload?.iteration === "number" ? payload.iteration : 0;
            emitOnce(`approval:${runId}:${nodeId}:${iteration}`, buildEventEntry(kind, runId, payload));
            continue;
          }
          sawTerminalEvent = true;
          if (kind === "run-cancelled") {
            cancellationObserved.add(runId);
          }
          if (!allTransitions && FYI_KINDS.has(kind)) {
            continue;
          }
          emit(buildEventEntry(kind, runId, payload));
        }
        if (!finalScan || rows.length < EVENT_PAGE_SIZE || cursor <= pageStart) {
          break;
        }
      }
      cursors.set(runId, cursor);
      if (!eventReadFailed && cursor > cursorAtScanStart) {
        // New rows landed since the last tick: the engine is durably
        // making progress even if its heartbeat timer is starved.
        // Use the row's persisted timestamp, not observation time, so
        // an old paginated backlog cannot keep a dead run alive.
        eventActivityAt.set(runId, newestPersistedEventAtMs ?? now());
      }
      if (finalScan && !eventReadFailed && !sawTerminalEvent) {
        // The engine commits the terminal run status BEFORE it persists the
        // RunFailed/RunFinished event row, so this one-shot final scan can
        // land inside that gap (or the event read can fail) and the line
        // would be lost forever. Synthesize it from the status we watched
        // flip; the event log is never read again for this run.
        const kind = TERMINAL_STATUS_KINDS.get(String(run.status ?? ""));
        if (kind && (allTransitions || !FYI_KINDS.has(kind))) {
          emit(buildEventEntry(kind, runId, undefined));
        }
      }
      if (finalScan && subscriptionsPath !== undefined) {
        // Terminal is terminal for every session; drop the run from the
        // registry so no future monitor re-inspects it.
        removeClaudeMirrorSubscription(subscriptionsPath, { runId, nowMs: now() });
      }
      // A terminal status is authoritative. Pending rows can be stale from
      // the cancellation/status-write race and must never become an
      // approval-pending notification for a run that can no longer resume.
      if (!finalScan) {
        // The run scan, event scan, and durable cancel marker are separate
        // reads. A RunCancelled event can arrive before the status flip, and
        // the cancel marker can arrive after listRuns. Re-read before any
        // actionable signal so neither race becomes a false stall.
        const currentRun = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
        if (
          cancellationObserved.has(runId) ||
          run.cancelRequestedAtMs != null ||
          currentRun?.cancelRequestedAtMs != null ||
          (currentRun && isTerminalClaudeMirrorRunStatus(currentRun.status))
        ) {
          stalledRuns.delete(runId);
          continue;
        }
        await emitPendingGates(adapter, runId, emitOnce);
        const attemptsRead = await readActiveAttempts(adapter, runId);
        const activeAttempts = attemptsRead.ok ? (attemptsRead.attempts ?? []) : [];
        for (const attemptRow of activeAttempts) {
          const heartbeatAtMs = Number(attemptRow?.heartbeatAtMs);
          if (Number.isFinite(heartbeatAtMs)) {
            taskHeartbeatActivityAt.set(runId, Math.max(taskHeartbeatActivityAt.get(runId) ?? 0, heartbeatAtMs));
          }
        }
        if (attemptsRead.ok && retryAlertAttempt > 0) {
          for (const attemptRow of activeAttempts) {
            emitRetryChurn(runId, attemptRow, retryAlertAttempt, emitOnce);
          }
        }
        if (eventReadFailed || !attemptsRead.ok) continue;
        const beforeStall = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
        if (
          beforeStall &&
          (beforeStall.cancelRequestedAtMs != null || isTerminalClaudeMirrorRunStatus(beforeStall.status))
        ) {
          stalledRuns.delete(runId);
          continue;
        }
        trackStall(
          beforeStall ?? currentRun ?? run,
          stalledAfterMs,
          stalledRuns,
          emit,
          now,
          Math.max(eventActivityAt.get(runId) ?? 0, taskHeartbeatActivityAt.get(runId) ?? 0) || undefined,
        );
        if (progressEveryMs > 0) {
          const lastLine = lastLineAt.get(runId);
          if (lastLine !== undefined && now() - lastLine >= progressEveryMs) {
            emit(buildProgressEntry(run, activeAttempts, now()));
          }
        }
      }
    }
    if (options.ticks !== undefined && tick >= options.ticks) {
      break;
    }
    await sleep(intervalMs);
  }
}

const ACTIVE_ATTEMPT_STATES = new Set(["in-progress", "waiting-approval", "waiting-event", "waiting-timer"]);

/**
 * Active attempt rows are durable evidence from the fenced task owner; they
 * feed the stall check (heartbeats), the retry-churn signal (attempt
 * numbers), and the progress digest (what is running right now). A failed
 * read is inconclusive, never evidence of a stall.
 *
 * @param {any} adapter
 * @param {string} runId
 * @returns {Promise<{ ok: true; attempts: any[] | undefined } | { ok: false }>}
 */
async function readActiveAttempts(adapter, runId) {
  if (typeof adapter.listAttemptsForRun !== "function") return { ok: true, attempts: undefined };
  let attempts;
  try {
    attempts = await Promise.resolve(adapter.listAttemptsForRun(runId));
  } catch {
    return { ok: false };
  }
  const rows = Array.isArray(attempts) ? attempts : [];
  return { ok: true, attempts: rows.filter((attemptRow) => ACTIVE_ATTEMPT_STATES.has(attemptRow?.state)) };
}

/**
 * A node grinding through retries crosses no failed or stalled transition, so
 * without this signal the monitor stays silent through exactly the churn a
 * supervising agent must report (issue #1413). Attempts are 1-based; fires
 * once per attempt number, so each escalation (attempt 3, then 4, then 5) is
 * announced exactly once.
 *
 * @param {string} runId
 * @param {any} attemptRow
 * @param {number} retryAlertAttempt
 * @param {(key: string, entry: Record<string, unknown>) => void} emitOnce
 */
function emitRetryChurn(runId, attemptRow, retryAlertAttempt, emitOnce) {
  const attempt = Number(attemptRow?.attempt);
  const nodeId = typeof attemptRow?.nodeId === "string" ? attemptRow.nodeId : "";
  if (!Number.isFinite(attempt) || attempt < retryAlertAttempt || nodeId.length === 0) {
    return;
  }
  const iteration = typeof attemptRow?.iteration === "number" ? attemptRow.iteration : 0;
  emitOnce(`retry:${runId}:${nodeId}:${iteration}:${attempt}`, {
    kind: "node-retrying",
    runId,
    nodeId,
    iteration,
    attempt,
    summary: `Run ${runId} node ${nodeId} is on attempt ${attempt}; earlier attempts failed or were interrupted.`,
    action: `Tell the user, then diagnose with: smithers node ${nodeId} -r ${runId} (pause with: smithers pause ${runId})`,
  });
}

/**
 * Periodic still-running digest: fires only when a followed run has produced
 * no monitor line for a full `progressEveryMs` window (every written line
 * resets the run's silence clock), so a healthy-but-quiet detached run still
 * hands the host agent a current status to relay (issue #1413).
 *
 * @param {any} run
 * @param {any[]} activeAttempts
 * @param {number} nowMs
 */
function buildProgressEntry(run, activeAttempts, nowMs) {
  const runId = run.runId;
  const startedAtMs = Number(run.startedAtMs ?? run.createdAtMs);
  const elapsed =
    Number.isFinite(startedAtMs) && nowMs > startedAtMs ? ` after ${formatElapsed(nowMs - startedAtMs)}` : "";
  const active = activeAttempts
    .filter((attemptRow) => typeof attemptRow?.nodeId === "string" && attemptRow.nodeId.length > 0)
    .sort((a, b) => Number(b?.attempt ?? 0) - Number(a?.attempt ?? 0))
    .slice(0, 3)
    .map((attemptRow) => `${attemptRow.nodeId} (attempt ${Number(attemptRow.attempt) || 1})`);
  const activeText = active.length > 0 ? `; active: ${active.join(", ")}` : "";
  return {
    kind: "run-progress",
    runId,
    summary: `Run ${runId} is still ${run.status}${elapsed} with no notable transitions in the last window${activeText}.`,
    action: `Give the user a brief status update, then check with: smithers status ${runId} (cancel with: smithers cancel ${runId})`,
  };
}

/** @param {number} ms */
function formatElapsed(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Resolve the subscribed runs this monitor follows: registry entries for this
 * session (or with no session), deduped by run id, looked up individually.
 * Runs missing from the store (a registry pointing at a wiped DB) drop out.
 *
 * @param {any} adapter
 * @param {string} subscriptionsPath
 * @param {string | undefined} sessionId
 * @param {number} nowMs
 */
async function listSubscribedRuns(adapter, subscriptionsPath, sessionId, nowMs) {
  const entries = readClaudeMirrorSubscriptions(subscriptionsPath, nowMs);
  const watched = entries.filter(
    (entry) => sessionId === undefined || entry.sessionId === null || entry.sessionId === sessionId,
  );
  const runIds = [...new Set(watched.map((entry) => entry.runId))];
  const runs = await Promise.all(runIds.map((runId) => Promise.resolve(adapter.getRun(runId)).catch(() => undefined)));
  return runs.filter((run) => run && typeof run.runId === "string");
}

/**
 * @param {any} adapter
 * @param {string} runId
 * @param {(key: string, entry: Record<string, unknown>) => void} emitOnce
 */
async function emitPendingGates(adapter, runId, emitOnce) {
  // Status and gate rows are separate durable records. Cancellation can win
  // between the monitor's run scan and these reads, so status is authoritative
  // at the point where an actionable notification would otherwise be emitted.
  const currentRun = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
  if (currentRun && isTerminalClaudeMirrorRunStatus(currentRun.status)) {
    return;
  }
  const approvals = await Promise.resolve(adapter.listPendingApprovals(runId)).catch(() => []);
  const afterApprovalRead = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
  if (afterApprovalRead && isTerminalClaudeMirrorRunStatus(afterApprovalRead.status)) {
    return;
  }
  for (const approval of approvals) {
    const beforeApprovalEmit = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
    if (beforeApprovalEmit && isTerminalClaudeMirrorRunStatus(beforeApprovalEmit.status)) return;
    emitOnce(`approval:${runId}:${approval.nodeId}:${approval.iteration ?? 0}`, {
      kind: "approval-pending",
      runId,
      nodeId: approval.nodeId,
      title: approvalTitle(approval.requestJson),
      summary: `Run ${runId} is waiting on approval for node ${approval.nodeId}.`,
      action: `Resolve with the resolve_approval MCP tool or: smithers approve ${runId} ${approval.nodeId}`,
    });
  }
  const humans = await Promise.resolve(adapter.listPendingHumanRequests()).catch(() => []);
  const beforeHumanEmit = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
  if (beforeHumanEmit && isTerminalClaudeMirrorRunStatus(beforeHumanEmit.status)) return;
  for (const request of humans) {
    if (request.runId !== runId) {
      continue;
    }
    const beforeRequestEmit = await Promise.resolve(adapter.getRun?.(runId)).catch(() => undefined);
    if (beforeRequestEmit && isTerminalClaudeMirrorRunStatus(beforeRequestEmit.status)) return;
    emitOnce(`human:${request.requestId}`, {
      kind: "human-request",
      runId,
      nodeId: request.nodeId,
      requestId: request.requestId,
      summary: `Run ${runId} is waiting on a human answer for node ${request.nodeId}.`,
      action: "Answer via the ask_human follow-up in chat, or: smithers inspect " + runId,
    });
  }
}

/**
 * @param {string} kind
 * @param {string} runId
 * @param {Record<string, any> | undefined} payload
 */
function buildEventEntry(kind, runId, payload) {
  if (kind === "run-continued") {
    const newRunId = typeof payload?.newRunId === "string" ? payload.newRunId : undefined;
    return {
      kind,
      runId,
      ...(newRunId ? { newRunId } : {}),
      summary: `Run ${runId} continued as ${newRunId ?? "a new run"}.`,
      action: newRunId ? `Follow it with: smithers claude tick ${newRunId}` : `Inspect with: smithers inspect ${runId}`,
    };
  }
  if (kind === "run-failed") {
    return {
      kind,
      runId,
      summary: `Run ${runId} failed.`,
      action: `Diagnose with: smithers inspect ${runId} (logs: smithers logs ${runId})`,
    };
  }
  if (kind === "approval-pending") {
    const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : undefined;
    return {
      kind,
      runId,
      ...(nodeId ? { nodeId } : {}),
      summary: `Run ${runId} is waiting on approval${nodeId ? ` for node ${nodeId}` : ""}.`,
      action: `Resolve with the resolve_approval MCP tool or: smithers approve ${runId}${nodeId ? ` ${nodeId}` : ""}`,
    };
  }
  return {
    kind,
    runId,
    summary: `Run ${runId} ${kind === "run-finished" ? "finished" : "was cancelled"}.`,
    action: `Review with: smithers inspect ${runId}`,
  };
}

/**
 * @param {any} run
 * @param {number} stalledAfterMs
 * @param {Set<string>} stalledRuns
 * @param {(entry: Record<string, unknown>) => void} emit
 * @param {() => number} now
 * @param {number | undefined} lastEventActivityAtMs
 */
function trackStall(run, stalledAfterMs, stalledRuns, emit, now, lastEventActivityAtMs) {
  const runId = run.runId;
  const heartbeat = typeof run.heartbeatAtMs === "number" ? run.heartbeatAtMs : undefined;
  const heartbeatLate = heartbeat !== undefined && now() - heartbeat > stalledAfterMs;
  // Heartbeat timers starve on a saturated engine while event persistence
  // keeps flowing, so recently persisted events count as liveness: a late
  // heartbeat alone must not flag a run that is still durably progressing.
  const recentEventActivity = lastEventActivityAtMs !== undefined && now() - lastEventActivityAtMs <= stalledAfterMs;
  // A recorded owner whose pid is demonstrably alive is a busy engine with a
  // lagging heartbeat (deriveRunState's "stale"), not a stalled run; alerting
  // on it flaps a false "run-stalled" every quiet stretch of a long agent
  // call. Only alert when no live owner process is verifiable on this host.
  const ownerPid = parseRuntimeOwnerPid(run.runtimeOwnerId);
  const ownerAlive = ownerPid !== null && isPidAlive(ownerPid);
  const isStalled = run.status === "running" && heartbeatLate && !recentEventActivity && !ownerAlive;
  if (isStalled && !stalledRuns.has(runId)) {
    stalledRuns.add(runId);
    emit({
      kind: "run-stalled",
      runId,
      summary: `Run ${runId} has not heartbeaten for over ${Math.round(stalledAfterMs / 1000)}s and shows no recent event activity.`,
      action: `Check it with: smithers why ${runId} (resume with: smithers up --resume ${runId})`,
    });
  } else if (!isStalled && stalledRuns.has(runId)) {
    stalledRuns.delete(runId);
  }
}

/** @param {unknown} payloadJson */
function parsePayload(payloadJson) {
  if (typeof payloadJson !== "string" || payloadJson.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} requestJson */
function approvalTitle(requestJson) {
  if (typeof requestJson !== "string" || requestJson.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(requestJson);
    const title = parsed?.title ?? parsed?.prompt ?? parsed?.description;
    return typeof title === "string" && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

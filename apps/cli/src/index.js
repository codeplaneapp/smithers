#!/usr/bin/env bun
import { setJsonMode } from "./util/logger.ts";
import { ensureCuratedSkillsFresh, formatRefreshNotice } from "./refreshCuratedSkills.js";
import { extractBackendFlag, findFirstPositionalIndex, rewriteBareResumeFlagArgv } from "./argv-utils.js";
import { CHAT_CREATE_PROMPT, INLINE_CHAT_ENGINES, buildInlineChatWorkflow } from "./buildInlineChatWorkflow.js";
import { readBackendMarkerForCwd } from "./readBackendMarkerForCwd.js";
import { parseJsonArgument, tryParseJsonInput } from "./json-args.js";
import { wrapCliCommandHandlersWithInputBounds } from "./cli-command-bounds.js";
import { resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSync, readFileSync, existsSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { Effect, Fiber } from "effect";
import { Cli, SyncSkills, z } from "incur";
import { isRunHeartbeatFresh, runWorkflow, renderFrame, resolveSchema } from "@smithers-orchestrator/engine";
import { readWorkflowEntryHash, readWorkflowGraphHash } from "@smithers-orchestrator/engine/workflow-hash";
import { mdxPlugin } from "./mdx-plugin.js";
import { approveNode, denyNode } from "@smithers-orchestrator/engine/approvals";
import { signalRun } from "@smithers-orchestrator/engine/signals";
import { loadInput, loadOutputs } from "@smithers-orchestrator/db/snapshot";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { buildStateKey } from "@smithers-orchestrator/scheduler/buildStateKey";
import { parseStateKey } from "@smithers-orchestrator/scheduler/parseStateKey";
import { SmithersCtx } from "@smithers-orchestrator/driver";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { runFork, runPromise, runSync } from "./smithersRuntime.js";
import { trackEvent } from "@smithers-orchestrator/observability/metrics";
import { vcsToolingStatus } from "@smithers-orchestrator/vcs/vcsToolingStatus";
import { findVcsRoot } from "@smithers-orchestrator/vcs/find-root";
import { listSmithersWorktrees } from "@smithers-orchestrator/engine/listSmithersWorktrees";
import { reapWorktrees } from "@smithers-orchestrator/engine/reapWorktrees";
import { revertToAttempt } from "@smithers-orchestrator/time-travel/revert";
import { retryTask } from "@smithers-orchestrator/time-travel/retry-task";
import { timeTravel } from "@smithers-orchestrator/time-travel/timetravel";
import { spawn } from "node:child_process";
import { CronExpressionParser } from "cron-parser";
import { buildAgentAskRequestRow, isHumanRequestPastTimeout, validateHumanRequestValue, waitForHumanAnswer, } from "@smithers-orchestrator/engine/human-requests";
import { SmithersError } from "@smithers-orchestrator/errors";
import { findAndOpenDb, findSmithersDb } from "./find-db.js";
import { cliWorkspace } from "./cliWorkspace.js";
import { cascadeCancelRun, finalizeCancelledOwnedRun, isCancellableRunStatus, listCascadeLineage } from "./cancel-cascade.js";
import { isDaemonDisabled } from "./isDaemonDisabled.js";
import { assertGatewayRuntimeStateFileTrusted, canonicalWorkspacePath, claimGatewayAutostartLock, claimGatewayDaemonStartLock, clearGatewayRuntimeState, discoverWorkspaceGateway, gatewayRuntimePaths, isGatewayPidAlive, mintGatewayToken, probeGatewayHealthIdentity, readGatewayRuntimeState, resolveGatewayBearer, verifyGatewayHealthIdentity, waitForWorkspaceGateway, writeGatewayRuntimeState } from "./gateway-runtime.js";
import { buildAskKindFields, buildAskPromptText, buildAskUniqueToken, formatAskHumanResolveHelp, parseChoices, resolveAskHumanContext, } from "./ask-human.js";
import { chatAttemptKey, formatChatAttemptHeader, formatChatBlock, parseAgentEvent, parseChatAttemptMeta, parseNodeOutputEvent, selectChatAttempts, } from "./chat.js";
import { buildHijackLaunchSpec, isNativeHijackCandidate, launchHijackSession, resolveHijackCandidate, waitForHijackCandidate, } from "./hijack.js";
import { mcpAddFallbackMessage } from "./agent-wiring/mcpAddFallbackMessage.js";
import { parseAgentWiringArgv } from "./agent-wiring/parseAgentWiringArgv.js";
import { EXTRA_MCP_AGENTS, EXTRA_SKILL_AGENTS, wireExtraAgents } from "./agent-wiring/wireExtraAgents.js";
import { launchConversationHijackSession, persistConversationHijackHandoff, } from "./hijack-session.js";
import { colorizeEventText, formatAge, formatElapsedCompact, formatEventLine, formatRelativeOffset, } from "./format.js";
import { EVENT_CATEGORY_VALUES, eventTypesForCategory, normalizeEventCategory, } from "./event-categories.js";
import { aggregateNodeDetailEffect, renderNodeDetailHuman, } from "./node-detail.js";
import { diagnoseRunEffect, diagnosisCtaCommands, renderWhyDiagnosisHuman, } from "./why-diagnosis.js";
import { buildRunStatusSummary, renderRunStatusHuman, runStatusCtaCommands, } from "./run-status.js";
import { detectAvailableAgents } from "./agent-detection.js";
import { listAccounts, removeAccount } from "@smithers-orchestrator/accounts";
import { getUsageForAccounts, formatUsageReports } from "@smithers-orchestrator/usage";
import { runAgentAdd, pingAccount } from "./agent-commands/runAgentAdd.js";
import { agentAddWizard } from "./agent-commands/agentAddWizard.js";
import { getWorkflowFollowUpCtas } from "./workflow-pack.js";
import { buildMonitoringGuidance, hasCustomUi, workflowIdFromPath } from "./monitoring-suggestion.js";
import { buildAgentNextSteps } from "./agentNextSteps.js";
import { generateRunReport } from "./runReport.js";
import { whatHappened } from "./what-happened.js";
import { openInBrowser } from "./openInBrowser.js";
import { parseCliErrorFromStderr } from "./util/errorMessage.js";
import { runBugCommand } from "./runBugCommand.js";
import { discoverWorkflows, resolveWorkflow, createWorkflowFile, renderWorkflowSkill, writeWorkflowSkillFiles, resolvePackDirs, summarizeWorkflowInputSchema, workflowInputJsonSchema } from "./workflows.js";
import { addPack, removePack, listPacks, listLockedPacks, updatePack, ejectPack } from "./packs.js";
import { sharePack } from "./share.js";
import { createEvalsExtension } from "./evals-extension.js";
import {
    assertEvalRunIdsAvailable,
    assertEvalReportWritable,
    buildEvalPlan,
    buildEvalReport,
    createEvalJudgeRunner,
    EVAL_JUDGE_PROVIDER_IDS,
    evaluateEvalCaseResultAsync,
    loadEvalCases,
    renderEvalPlan,
    renderEvalReport,
    writeEvalReport,
} from "./eval-suite.js";
import { initArgs, initOptions, runInitCommand } from "./init-command.js";
import { runDurableAdd } from "./add-command.js";
import { startersArgs, startersOptions, runStartersCommand } from "./starter-gallery-command.js";
import { runTuiCommand } from "./tui.js";
import { optimizeOptions, runOptimizeCommand, withOptimizationArtifactEnv } from "./optimize-command.js";
import { ask } from "./ask.js";
import { runScheduler } from "./scheduler.js";
import { resumeRunDetached } from "./resume-detached.js";
import { launchPostFailureAutopsy } from "./launchPostFailureAutopsy.js";
import { resolveLaunchRootDir, parsePersistedRootDir } from "./resolve-root.js";
import { DETACHED_RUN_LOG_FILE_ENV } from "./detachedRunLogEnv.js";
import { reapDetachedRunLogs } from "./reapDetachedRunLogs.js";
import { removeDetachedRunLog } from "./removeDetachedRunLog.js";
import { resolveDetachedRunLogFile } from "./resolveDetachedRunLogFile.js";
import { formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, } from "@smithers-orchestrator/agents/cli-capabilities";
import { findAndOpenSupervisorDb, parseDurationMs, supervisorLoopEffect, supervisorPollEffect, } from "./supervisor.js";
import { DEFAULT_LIFECYCLE_EVENT_TYPES, renderAttemptPool, tallyAttemptPool } from "./observability-helpers.js";
import { buildDurabilityRunOptions } from "./up-engine-options.js";
import { WATCH_MIN_INTERVAL_MS, runWatchLoop, watchIntervalSecondsToMs, } from "./watch.js";
import { runMcpModeIfRequested } from "./mcp/mcp-mode.js";
import { issueSmithersBrokerToken, parseTokenScopes, readSmithersTokenStore, resolveSmithersActionTokenFromStore, revokeSmithersToken, smithersTokenStorePath, writeSmithersTokenStore, } from "./token-store.js";
import { resolveSmithersDocsSource } from "./docs-command.js";
import {
    SMITHERS_PACKAGE,
    buildUpdatePlan,
    detectInstallMethod,
    ensureUpdateCheck,
    fetchLatestVersion,
    fetchRemoteSotaVersion,
    formatUpdateNotice,
    isUpdateAvailable,
} from "./update-check.js";
import { SOTA_REGISTRY_VERSION } from "./sota-models.generated.js";
import { reportReplayResult } from "./reportReplayResult.js";
import { buildClaudeMirrorTick } from "./claude-mirror/buildClaudeMirrorTick.js";
import { buildClaudeNodeWait } from "./claude-mirror/buildClaudeNodeWait.js";
import { runClaudeMonitor } from "./claude-mirror/runClaudeMonitor.js";
import { waitForClaudeMirrorChange } from "./claude-mirror/waitForClaudeMirrorChange.js";
import { isTerminalClaudeMirrorRunStatus } from "./claude-mirror/isTerminalClaudeMirrorRunStatus.js";
import { resolveClaudeMirrorSubscriptionsPath } from "./claude-mirror/resolveClaudeMirrorSubscriptionsPath.js";
import { upsertClaudeMirrorSubscription } from "./claude-mirror/upsertClaudeMirrorSubscription.js";
import { removeClaudeMirrorSubscription } from "./claude-mirror/removeClaudeMirrorSubscription.js";
import { subscribeClaudeSessionRun } from "./claude-mirror/subscribeClaudeSessionRun.js";
import { isAgentHarness } from "./util/envDetect.js";
import pc from "picocolors";
import crypto from "node:crypto";
import React from "react";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * @param {string} path
 * @returns {Promise<SmithersWorkflow<any>>}
 */
async function loadWorkflowAsync(path) {
    const abs = resolve(cliWorkspace.cwd(), path);
    mdxPlugin();
    const mod = await import(pathToFileURL(abs).href);
    if (!mod.default)
        throw new SmithersError("WORKFLOW_MISSING_DEFAULT", "Workflow must export default");
    // A built smithers workflow is an object carrying a `build` function and
    // `opts`. Raw component exports (a bare function returning <Workflow>) or
    // JSX elements slip past the `mod.default` check and later blow up deep in
    // the DB adapter as `undefined is not an object (evaluating 'db.session')`,
    // because nothing wrapped them with `smithers(...)` to attach a `.db`.
    // Catch that here with an actionable authoring error instead.
    const wf = mod.default;
    if (typeof wf !== "object" ||
        wf === null ||
        typeof wf.build !== "function" ||
        typeof wf.opts !== "object") {
        throw new SmithersError("WORKFLOW_NOT_BUILT", "Workflow default export must be created with `smithers(...)`. You exported a raw component or element. Wrap the body:\n" +
            "  const { Workflow, smithers, outputs } = createSmithers({ /* schemas */ });\n" +
            "  export default smithers((ctx) => <Workflow>…</Workflow>);");
    }
    return wf;
}
// Advertise this CLI's module directory to workflows launched by it. System
// workflows (the seeded `init`) import CLI internals through this so they
// always run the exact code that launched them, instead of depending on
// `@smithers-orchestrator/cli` being resolvable from the pack's node_modules.
process.env.SMITHERS_CLI_SRC_DIR ??= dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} path
 */
function loadWorkflowEffect(path) {
    return Effect.tryPromise({
        try: () => loadWorkflowAsync(path),
        catch: (cause) => toSmithersError(cause, "cli load workflow"),
    }).pipe(Effect.annotateLogs({ workflowPath: path }), Effect.withLogSpan("cli:load-workflow"));
}
/**
 * @param {string} path
 * @returns {Promise<SmithersWorkflow<any>>}
 */
async function loadWorkflow(path) {
    return runPromise(loadWorkflowEffect(path));
}
/**
 * @param {string} workflowPath
 * @returns {Promise<{ adapter: SmithersDb; cleanup?: () => void }>}
 */
async function loadWorkflowDb(workflowPath) {
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db);
    setupSqliteCleanup(workflow);
    return { adapter: new SmithersDb(workflow.db) };
}
/**
 * @returns {string}
 */
function readPackageVersion() {
    try {
        const pkgUrl = new URL("../package.json", import.meta.url);
        const raw = readFileSync(pkgUrl, "utf8");
        const parsed = JSON.parse(raw);
        return typeof parsed.version === "string" ? parsed.version : "unknown";
    }
    catch {
        return "unknown";
    }
}
// DB poll cadence for --follow loops (logs, chat): fast enough to feel live,
// slow enough not to hammer sqlite.
const FOLLOW_POLL_INTERVAL_MS = 500;
// Hard-exit deadline once a graceful shutdown starts, so a hung shutdown never
// requires `kill -9`.
const FORCE_EXIT_BACKSTOP_MS = 5000;
/**
 * @param {string | undefined} status
 */
function formatStatusExitCode(status) {
    if (status === "finished")
        return 0;
    if (status === "waiting-approval" ||
        status === "waiting-event" ||
        status === "waiting-timer" ||
        status === "paused") {
        return 3;
    }
    if (status === "cancelled")
        return 2;
    return 1;
}
const LOG_FOLLOW_ACTIVE_STATES = new Set([
    "running",
    "waiting-approval",
    "waiting-event",
    "waiting-timer",
]);
/**
 * @param {unknown} state
 * @returns {boolean}
 */
function isLogFollowActiveState(state) {
    return typeof state === "string" && LOG_FOLLOW_ACTIVE_STATES.has(state);
}
/**
 * @param {string} runId
 * @param {import("@smithers-orchestrator/db/runState").RunStateView | undefined} stateView
 */
function reportLogFollowInactiveDerivedState(runId, stateView) {
    if (stateView?.state !== "stale" && stateView?.state !== "orphaned")
        return;
    const lastHeartbeatAt = stateView.unhealthy?.kind === "engine-heartbeat-stale"
        ? stateView.unhealthy.lastHeartbeatAt
        : undefined;
    process.stderr.write(`[smithers] Run ${runId} is ${stateView.state}; stopping log follow${lastHeartbeatAt ? ` (last heartbeat ${lastHeartbeatAt})` : ""}.\n`);
}
/**
 * The run's output is the last task's stored output, which arrives as a row array
 * carrying internal run_id/node_id/iteration columns. Strip those and unwrap a
 * single row so the printed `output` is the useful payload a workflow surfaced.
 * @param {unknown} value
 */
function normalizeRunOutputForDisplay(value) {
    const strip = (row) => {
        if (!row || typeof row !== "object" || Array.isArray(row))
            return row;
        const out = {};
        for (const [key, val] of Object.entries(row)) {
            if (key === "runId" || key === "nodeId" || key === "iteration" || key === "run_id" || key === "node_id")
                continue;
            out[key] = val;
        }
        return out;
    };
    if (!Array.isArray(value))
        return strip(value);
    const rows = value.map(strip);
    if (rows.length === 0)
        return null;
    if (rows.length === 1)
        return rows[0];
    return rows;
}
/**
 * Build the printed run summary: normalize `output` to its useful payload and
 * omit it entirely when there is nothing to show, so a successful run never
 * prints a noisy `output: null`.
 * @param {{ output?: unknown }} result
 */
function summarizeRunResult(result) {
    const normalized = normalizeRunOutputForDisplay(result.output);
    const { output: _drop, ...rest } = result;
    return normalized == null ? rest : { ...rest, output: normalized };
}
/**
 * @param {string | null | undefined} status
 */
function isWaitingStatus(status) {
    return (status === "waiting-approval" ||
        status === "waiting-event" ||
        status === "waiting-timer" ||
        status === "paused");
}
/**
 * CTAs shown when `up` ends in a paused (waiting-* or paused) state, so exit code 3 reads
 * as "awaiting a decision" rather than a failure.
 * @param {string | null | undefined} status
 * @param {string} runId
 */
function pauseCtas(status, runId) {
    if (status === "paused")
        return [{ command: `up --resume ${runId}`, description: "Resume the paused run" }];
    if (status === "waiting-approval")
        return [
            { command: `approve ${runId}`, description: "Approve the paused gate" },
            { command: `deny ${runId}`, description: "Reject the paused gate" },
            { command: `why ${runId}`, description: "Explain why the run is paused" },
        ];
    if (status === "waiting-event")
        return [
            { command: `signal ${runId} <event>`, description: "Send the awaited signal" },
            { command: `why ${runId}`, description: "Explain the signal wait" },
        ];
    if (status === "waiting-timer")
        return [{ command: `why ${runId}`, description: "Explain the timer wait" }];
    return [];
}
/**
 * Merge a command's own ctas with the shared agent next-steps guidance
 * (buildAgentNextSteps), deduplicating by command string so no suggestion
 * appears twice.
 * @param {Parameters<typeof buildAgentNextSteps>[0]} context
 * @param {{ command: string; description?: string }[]} [ownCommands]
 * @param {string} [ownDescription]
 */
function withAgentNextSteps(context, ownCommands = [], ownDescription) {
    const next = buildAgentNextSteps(context);
    const seen = new Set(ownCommands.map((cmd) => cmd.command));
    // The human next-steps carry no description of their own (the caller's
    // ownDescription is the header), so join only the parts that exist.
    const description = [ownDescription, next.description].filter(Boolean).join("\n\n");
    return {
        description,
        commands: [
            ...ownCommands,
            ...next.commands.filter((cmd) => !seen.has(cmd.command)),
        ],
    };
}
/**
 * Devtools commands (tree/rewind/snapshots) own stdout and must keep stderr
 * clean on success, so their agent guidance is appended to the human render
 * only. Callers must skip this in --json mode (machine-parsed stdout) and for
 * machine-consumable payloads like `diff` patches and `output` rows.
 * @param {Parameters<typeof buildAgentNextSteps>[0]} context
 */
function writeAgentNextStepsHuman(context) {
    try {
        const next = buildAgentNextSteps(context);
        const lines = [
            next.description,
            "",
            "Next commands:",
            ...next.commands.map((cmd) => `  smithers ${cmd.command}   # ${cmd.description}`),
        ];
        process.stdout.write(`\n${lines.join("\n")}\n`);
    }
    catch {
        // Guidance must never break the command.
    }
}
/**
 * @param {SmithersWorkflow<any>} workflow
 */
function setupSqliteCleanup(workflow) {
    const closeSqlite = () => {
        try {
            const client = workflow.db?.$client;
            if (client && typeof client.close === "function") {
                client.close();
            }
        }
        catch { }
    };
    // Close sqlite when the process exits naturally (after graceful shutdown).
    // Do NOT register SIGINT/SIGTERM handlers here: a synchronous process.exit()
    // on the signal fires before the graceful abort handler (setupAbortSignal /
    // serve / gateway shutdown), so the run's `status:"cancelled"` write never
    // happens and the run is left stuck "running" until its heartbeat goes stale.
    process.on("exit", closeSqlite);
}

async function closeWorkflowBackend(workflow) {
    const close = workflow?.close ?? workflow?.db?.close;
    if (typeof close === "function") {
        await close.call(workflow?.close ? workflow : workflow.db);
    }
}

function redactConnectionStringForCli(value) {
    if (!value) return value;
    try {
        const url = new URL(String(value));
        const auth = url.username || url.password ? "<redacted>:<redacted>@" : "";
        return `${url.protocol}//${auth}${url.host}${url.pathname}${url.search}${url.hash}`;
    }
    catch {
        return "<redacted>";
    }
}
function buildProgressReporter() {
    const startTime = Date.now();
    const formatElapsed = () => {
        const elapsed = Date.now() - startTime;
        const secs = Math.floor(elapsed / 1000);
        const mins = Math.floor(secs / 60);
        const hrs = Math.floor(mins / 60);
        /**
     * @param {number} n
     */
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(hrs)}:${pad(mins % 60)}:${pad(secs % 60)}`;
    };
    return (event) => {
        const ts = formatElapsed();
        switch (event.type) {
            case "NodeStarted":
                process.stderr.write(`[${ts}] → ${event.nodeId} (attempt ${event.attempt ?? 1}, iteration ${event.iteration ?? 0})\n`);
                break;
            case "NodeFinished":
                process.stderr.write(`[${ts}] ✓ ${event.nodeId} (attempt ${event.attempt ?? 1})\n`);
                break;
            case "NodeFailed":
                process.stderr.write(`[${ts}] ✗ ${event.nodeId} (attempt ${event.attempt ?? 1}): ${typeof event.error === "string" ? event.error : (event.error?.message ?? "failed")}\n`);
                break;
            case "NodeRetrying":
                process.stderr.write(`[${ts}] ↻ ${event.nodeId} retrying (attempt ${event.attempt ?? 1})\n`);
                break;
            case "NodeWaitingTimer":
                process.stderr.write(`[${ts}] ⏱ ${event.nodeId} waiting for timer (fires ${new Date(event.firesAtMs).toISOString()})\n`);
                break;
            case "TimerCreated":
                process.stderr.write(`[${ts}] ⏱ Timer created: ${event.timerId} (fires ${new Date(event.firesAtMs).toISOString()})\n`);
                break;
            case "TimerFired":
                process.stderr.write(`[${ts}] 🔔 Timer fired: ${event.timerId} (delay ${event.delayMs}ms)\n`);
                break;
            case "RunFinished":
                process.stderr.write(`[${ts}] ✓ Run finished\n`);
                break;
            case "RunFailed":
                process.stderr.write(`[${ts}] ✗ Run failed: ${typeof event.error === "string" ? event.error : (event.error?.message ?? "unknown")}\n`);
                break;
            case "RetryTaskStarted":
                process.stderr.write(`[${ts}] ↻ retrying ${event.nodeId} (reset: ${(event.resetNodes ?? []).join(", ") || event.nodeId})\n`);
                break;
            case "RetryTaskFinished":
                process.stderr.write(`[${ts}] ${event.success ? "✓" : "✗"} retry reset ${event.success ? "finished" : "failed"} for ${event.nodeId}${event.error ? `: ${event.error}` : ""}\n`);
                break;
            case "FrameCommitted":
                break;
            case "WorkflowReloadDetected":
                process.stderr.write(`[${ts}] ⟳ File change detected: ${event.changedFiles?.length ?? 0} file(s)\n`);
                break;
            case "WorkflowReloaded":
                process.stderr.write(`[${ts}] ⟳ Workflow reloaded (generation ${event.generation})\n`);
                break;
            case "WorkflowReloadFailed":
                process.stderr.write(`[${ts}] ⚠ Workflow reload failed: ${typeof event.error === "string" ? event.error : (event.error?.message ?? "unknown")}\n`);
                break;
            case "WorkflowReloadUnsafe":
                process.stderr.write(`[${ts}] ⚠ Workflow reload blocked: ${event.reason}\n`);
                break;
        }
    };
}
/**
 * @param {string | null} [metaJson]
 * @returns {WaitingTimerInfo | null}
 */
function parseWaitingTimerInfo(metaJson) {
    if (!metaJson)
        return null;
    try {
        const parsed = JSON.parse(metaJson);
        const timer = parsed?.timer;
        if (!timer || typeof timer !== "object")
            return null;
        const nodeId = typeof timer.timerId === "string" ? timer.timerId : null;
        const firesAtMs = Number(timer.firesAtMs);
        if (!nodeId || !Number.isFinite(firesAtMs))
            return null;
        return {
            nodeId,
            iteration: 0,
            firesAtMs: Math.floor(firesAtMs),
            timerType: timer.timerType === "absolute" ? "absolute" : "duration",
        };
    }
    catch {
        return null;
    }
}
/**
 * @param {number} ms
 * @returns {string}
 */
function formatRemainingTimer(ms) {
    if (ms <= 0)
        return "due now";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listWaitingTimers(adapter, runId) {
    const nodes = await adapter.listNodes(runId);
    const waits = [];
    for (const node of nodes) {
        if (node.state !== "waiting-timer")
            continue;
        const attempts = await adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0);
        const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-timer") ??
            attempts[0];
        const parsed = parseWaitingTimerInfo(waitingAttempt?.metaJson);
        if (!parsed)
            continue;
        waits.push({
            ...parsed,
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
        });
    }
    waits.sort((left, right) => left.firesAtMs - right.firesAtMs);
    return waits;
}
function setupAbortSignal() {
    const abort = new AbortController();
    let signalCount = 0;
    /**
   * @param {string} signal
   */
    const handleSignal = (signal) => {
        const exitCode = signal === "SIGINT" ? 130 : 143;
        signalCount += 1;
        if (signalCount >= 2) {
            // Second signal: graceful cancellation is taking too long — exit now.
            process.stderr.write(`\n[smithers] received ${signal} again, exiting immediately.\n`);
            process.exit(exitCode);
            return;
        }
        process.stderr.write(`\n[smithers] received ${signal}, cancelling run... (press again to force-exit)\n`);
        abort.abort();
        // Backstop: if graceful cancellation hangs, force-exit after 5s so a hard
        // `kill -9` is never required. unref() so this timer never keeps the loop
        // alive when shutdown completes normally.
        const deadline = setTimeout(() => {
            process.stderr.write(`\n[smithers] graceful shutdown timed out, exiting.\n`);
            process.exit(exitCode);
        }, FORCE_EXIT_BACKSTOP_MS);
        if (typeof deadline.unref === "function")
            deadline.unref();
    };
    // process.on (not once) so a second signal still reaches handleSignal.
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    return abort;
}
/**
 * @param {string | null | undefined} status
 */
function isRunStatusTerminal(status) {
    return (status !== "running" &&
        status !== "waiting-approval" &&
        status !== "waiting-timer" &&
        status !== "waiting-event");
}
/**
 * Fetch a docs file and write it to stdout.
 * Honors --json (global) by emitting `{ url, content }`.
 *
 * @param {{ error: Function; ok: Function; format?: string; options?: { json?: boolean } }} c
 * @param {string} file
 * @param {string} errorCode
 */
async function printSmithersDocs(c, file, errorCode) {
    const cliSourceRoot = dirname(fileURLToPath(import.meta.url));
    const localDocsRoots = [
        resolve(cliSourceRoot, "../docs"),
        resolve(cliSourceRoot, "../../../docs"),
    ];
    let source;
    try {
        source = resolveSmithersDocsSource({
            file,
            latest: Boolean(c.options?.latest),
            version: typeof c.options?.docsVersion === "string" ? c.options.docsVersion : undefined,
            packageVersion: readPackageVersion(),
            localDocsRoots,
        });
    }
    catch (err) {
        return c.error({
            code: "DOCS_OPTIONS_INVALID",
            message: err?.message ?? String(err),
            exitCode: 1,
        });
    }

    let body;
    if (source.kind === "local") {
        try {
            body = readFileSync(source.path, "utf8");
        }
        catch (err) {
            return c.error({
                code: errorCode,
                message: `Failed to read ${source.path}: ${err?.message ?? String(err)}`,
                exitCode: 1,
            });
        }
    }
    else {
        try {
            let res = await fetch(source.url);
            // smithers.sh only serves versioned artifacts for >= 0.27.0; on a
            // miss for an explicit --docs-version, fall back to the git tag's raw
            // docs, which exist for every tag.
            if (!res.ok && source.fallbackUrl) {
                res = await fetch(source.fallbackUrl);
            }
            if (!res.ok) {
                const attempted = source.fallbackUrl
                    ? `${source.url} and ${source.fallbackUrl}`
                    : source.url;
                return c.error({
                    code: errorCode,
                    message: `Failed to fetch ${attempted}: HTTP ${res.status}`,
                    exitCode: 1,
                });
            }
            body = await res.text();
        }
        catch (err) {
            return c.error({
                code: errorCode,
                message: `Failed to fetch ${source.url}: ${err?.message ?? String(err)}`,
                exitCode: 1,
            });
        }
    }
    const wantsJson = Boolean(c.options?.json) || c.format === "json";
    if (wantsJson) {
        return c.ok({ url: source.url, content: body });
    }
    // Synchronous write: the docs bundle exceeds the OS pipe buffer (~64KB), so a
    // plain async write would be truncated when the process exits. See writeStdoutSync.
    writeStdoutSync(body.endsWith("\n") ? body : `${body}\n`);
    return c.ok(undefined);
}
/**
 * @param {string | undefined} format
 * @param {unknown} payload
 * @param {string} [human]
 */
function writeWatchOutput(format, payload, human) {
    if (format === "jsonl") {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        return;
    }
    if (format === "json") {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    if (human !== undefined) {
        process.stdout.write(`${human}\n`);
        return;
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
/**
 * @param {string} value
 * @param {number} maxLength
 */
function truncateCliText(value, maxLength) {
    return value.length <= maxLength
        ? value
        : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
/**
 * @param {any[]} requests
 */
function renderHumanInboxHuman(requests) {
    if (requests.length === 0) {
        return "No pending human requests.";
    }
    return requests
        .map((request) => {
        const age = typeof request.requestedAtMs === "number"
            ? formatAge(request.requestedAtMs)
            : "unknown";
        const workflowName = typeof request.workflowName === "string" && request.workflowName.length > 0
            ? ` (${request.workflowName})`
            : "";
        return [
            `${request.requestId}`,
            `  kind: ${request.kind}`,
            `  run: ${request.runId}${workflowName}`,
            `  node: ${request.nodeId}#${request.iteration ?? 0}`,
            `  age: ${age}`,
            `  prompt: ${truncateCliText(String(request.prompt ?? ""), 160)}`,
        ].join("\n");
    })
        .join("\n\n");
}
/**
 * @param {any[]} alerts
 */
function renderAlertsHuman(alerts) {
    if (alerts.length === 0) {
        return "No active alerts.";
    }
    return alerts
        .map((alert) => {
        const age = typeof alert.firedAtMs === "number"
            ? formatAge(alert.firedAtMs)
            : "unknown";
        return [
            `${alert.alertId}`,
            `  severity: ${alert.severity}`,
            `  status: ${alert.status}`,
            `  policy: ${alert.policyName}`,
            ...(alert.runId ? [`  run: ${alert.runId}`] : []),
            `  age: ${age}`,
            `  message: ${truncateCliText(String(alert.message ?? ""), 160)}`,
        ].join("\n");
    })
        .join("\n\n");
}
/**
 * @param {string} command
 * @param {number} intervalSeconds
 * @param {FailFn} fail
 */
function resolveWatchIntervalMsOrFail(command, intervalSeconds, fail) {
    try {
        const intervalMs = watchIntervalSecondsToMs(intervalSeconds);
        if (intervalMs !== intervalSeconds * 1_000) {
            process.stderr.write(`[smithers] --interval clamped to ${WATCH_MIN_INTERVAL_MS}ms for ${command} watch mode\n`);
        }
        return intervalMs;
    }
    catch (error) {
        return fail({
            code: "INVALID_WATCH_INTERVAL",
            message: error?.message ?? String(error),
            exitCode: 4,
        });
    }
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listAllEvents(adapter, runId) {
    const events = [];
    let lastSeq = -1;
    while (true) {
        const batch = await adapter.listEvents(runId, lastSeq, 1000);
        if (batch.length === 0)
            break;
        events.push(...batch);
        lastSeq = batch[batch.length - 1].seq;
        if (batch.length < 1000)
            break;
    }
    return events;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<string[]>}
 */
async function listAncestryRunIds(adapter, runId) {
    const ancestry = await adapter.listRunAncestry(runId, 10_000);
    if (!ancestry || ancestry.length === 0)
        return [runId];
    // listRunAncestry returns [current, parent, grandparent, ...]
    return ancestry.map((row) => row.runId);
}
/**
 * @param {any} c
 */
async function* streamRunEventsCommand(c) {
    let adapter;
    let cleanup;
    try {
        const db = await findAndOpenDb();
        adapter = db.adapter;
        cleanup = db.cleanup;
        const run = await adapter.getRun(c.args.runId);
        if (!run) {
            yield `Error: Run not found: ${c.args.runId}`;
            return;
        }
        const includeAncestry = Boolean(c.options.followAncestry);
        const lineageCurrentToRoot = includeAncestry
            ? await listAncestryRunIds(adapter, c.args.runId)
            : [c.args.runId];
        const lineageRootToCurrent = [...lineageCurrentToRoot].reverse();
        const runOrder = new Map(lineageRootToCurrent.map((runId, index) => [runId, index]));
        const lineageRuns = await Promise.all(lineageRootToCurrent.map((lineageRunId) => adapter.getRun(lineageRunId)));
        const firstLineageRun = lineageRuns.find((entry) => Boolean(entry));
        const baseMs = firstLineageRun?.startedAtMs ??
            firstLineageRun?.createdAtMs ??
            run.startedAtMs ??
            run.createdAtMs ??
            Date.now();
        /**
     * @param {any} event
     */
        const formatLine = (event) => {
            const line = formatEventLine(event, baseMs);
            if (!includeAncestry)
                return line;
            const runPrefix = String(event.runId ?? "").slice(0, 12);
            return `${runPrefix} ${line}`;
        };
        // --from-seq is the preferred cursor flag; --since remains a deprecated
        // alias (it collides with `events --since`, which is a duration). (#10)
        const fromSeq = c.options.fromSeq ?? c.options.since;
        if (c.options.since !== undefined && c.options.fromSeq === undefined) {
            process.stderr.write("[smithers] logs --since is an event sequence number; prefer --from-seq (`events --since` takes a duration window like 5m).\n");
        }
        let lastSeq = fromSeq ?? -1;
        if (!includeAncestry && fromSeq === undefined) {
            const lastEventSeq = await adapter.getLastEventSeq(c.args.runId);
            if (lastEventSeq !== undefined) {
                lastSeq = Math.max(-1, lastEventSeq - c.options.tail);
            }
        }
        let initialEvents = [];
        if (includeAncestry) {
            const merged = [];
            for (const lineageRunId of lineageRootToCurrent) {
                const events = await listAllEvents(adapter, lineageRunId);
                for (const event of events) {
                    merged.push({ ...event, runId: lineageRunId });
                }
            }
            merged.sort((left, right) => {
                if (left.timestampMs !== right.timestampMs) {
                    return left.timestampMs - right.timestampMs;
                }
                const leftOrder = runOrder.get(left.runId) ?? 0;
                const rightOrder = runOrder.get(right.runId) ?? 0;
                if (leftOrder !== rightOrder)
                    return leftOrder - rightOrder;
                return (left.seq ?? 0) - (right.seq ?? 0);
            });
            initialEvents =
                fromSeq !== undefined
                    ? merged.filter((event) => (event.seq ?? -1) > fromSeq)
                    : merged.slice(-c.options.tail);
            const lastCurrentEvent = [...initialEvents]
                .reverse()
                .find((event) => event.runId === c.args.runId);
            lastSeq = lastCurrentEvent?.seq ?? -1;
        }
        else {
            initialEvents = await adapter.listEvents(c.args.runId, lastSeq, 1000);
            for (const event of initialEvents) {
                lastSeq = event.seq;
            }
        }
        for (const event of initialEvents) {
            yield formatLine(event);
            if (!includeAncestry) {
                lastSeq = event.seq;
            }
            else if (event.runId === c.args.runId) {
                lastSeq = event.seq;
            }
        }
        const initialRunState = await computeRunStateFromRow(adapter, run);
        const initialFollowState = initialRunState.state === "succeeded"
            ? "finished"
            : initialRunState.state;
        const isActive = isLogFollowActiveState(initialFollowState);
        if (!c.options.follow || !isActive) {
            if (c.options.follow) {
                reportLogFollowInactiveDerivedState(c.args.runId, initialRunState);
            }
            return c.ok(undefined, {
                cta: {
                    commands: [{ command: `inspect ${c.args.runId}`, description: "Inspect run state" }],
                },
            });
        }
        let lastWaitingStatus = initialFollowState === "waiting-approval" ||
            initialFollowState === "waiting-event" ||
            initialFollowState === "waiting-timer"
            ? initialFollowState
            : undefined;
        while (true) {
            await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_INTERVAL_MS));
            const newEvents = await adapter.listEvents(c.args.runId, lastSeq, 200);
            for (const event of newEvents) {
                yield formatLine(event);
                lastSeq = event.seq;
            }
            const currentRun = await adapter.getRun(c.args.runId);
            const currentRunState = currentRun
                ? await computeRunStateFromRow(adapter, currentRun)
                : undefined;
            const currentStatus = currentRunState?.state === "succeeded"
                ? "finished"
                : currentRunState?.state;
            if (currentStatus === "waiting-approval" ||
                currentStatus === "waiting-event" ||
                currentStatus === "waiting-timer") {
                lastWaitingStatus = currentStatus;
            }
            if (!isLogFollowActiveState(currentStatus)) {
                reportLogFollowInactiveDerivedState(c.args.runId, currentRunState);
                const finalEvents = await adapter.listEvents(c.args.runId, lastSeq, 1000);
                for (const event of finalEvents) {
                    yield formatLine(event);
                    lastSeq = event.seq;
                }
                const ctaCommands = [
                    { command: `inspect ${c.args.runId}`, description: "Inspect run state" },
                ];
                if (lastWaitingStatus === "waiting-approval") {
                    ctaCommands.push({ command: `approve ${c.args.runId}`, description: "Approve run" });
                }
                if (lastWaitingStatus === "waiting-event") {
                    ctaCommands.push({ command: `why ${c.args.runId}`, description: "Explain signal wait" });
                }
                if (lastWaitingStatus === "waiting-timer") {
                    ctaCommands.push({ command: `why ${c.args.runId}`, description: "Explain timer wait" });
                }
                return c.ok(undefined, { cta: { commands: ctaCommands } });
            }
        }
    }
    finally {
        cleanup?.();
    }
}
const DEFAULT_EVENTS_LIMIT = 1_000;
const MAX_EVENTS_LIMIT = 100_000;
const EVENTS_PAGE_SIZE = 1_000;
const DOWN_ACTIVE_RUN_SCAN_LIMIT = 1_000;
/**
 * @param {string} payloadJson
 * @returns {Record<string, unknown>}
 */
function parseEventPayload(payloadJson) {
    try {
        const parsed = JSON.parse(payloadJson);
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    }
    catch {
        // ignore malformed payloads
    }
    return {};
}
/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseEventNumber(value) {
    const asNumber = typeof value === "number"
        ? value
        : typeof value === "string"
            ? Number(value)
            : NaN;
    if (!Number.isFinite(asNumber))
        return null;
    return Math.floor(asNumber);
}
/**
 * @param {string | undefined} groupByRaw
 * @returns {EventGroupBy | undefined}
 */
function normalizeEventGroupBy(groupByRaw) {
    if (!groupByRaw)
        return undefined;
    const normalized = groupByRaw.trim().toLowerCase();
    if (normalized === "node" || normalized === "attempt") {
        return normalized;
    }
    throw new SmithersError("INVALID_GROUP_BY", `Invalid --group-by value "${groupByRaw}". Use "node" or "attempt".`);
}
/**
 * @param {number | undefined} limit
 * @returns {{ value: number; defaultLimitUsed: boolean; limitCapped: boolean; }}
 */
function normalizeEventsLimit(limit) {
    if (limit === undefined) {
        return {
            value: DEFAULT_EVENTS_LIMIT,
            defaultLimitUsed: true,
            limitCapped: false,
        };
    }
    if (limit > MAX_EVENTS_LIMIT) {
        return {
            value: MAX_EVENTS_LIMIT,
            defaultLimitUsed: false,
            limitCapped: true,
        };
    }
    return {
        value: limit,
        defaultLimitUsed: false,
        limitCapped: false,
    };
}
/**
 * @param {EventHistoryRow} event
 * @param {number} baseMs
 * @returns {string}
 */
function buildEventHistoryLine(event, baseMs) {
    const seqLabel = `#${event.seq + 1}`;
    const offset = formatRelativeOffset(baseMs, event.timestampMs);
    const typeText = event.type.padEnd(20, " ");
    const coloredType = colorizeEventText(event.type, typeText);
    const summary = formatEventLine(event, baseMs, {
        includeTimestamp: false,
        truncatePayloadAt: 220,
    });
    return `${seqLabel}  ${offset}  ${coloredType}  ${summary}`;
}
/**
 * @param {EventHistoryRow} event
 * @returns {string}
 */
function buildEventNdjsonLine(event) {
    const payload = parseEventPayload(event.payloadJson);
    return JSON.stringify({
        runId: event.runId,
        seq: event.seq,
        timestampMs: event.timestampMs,
        type: event.type,
        payload,
    });
}
/**
 * @param {EventHistoryRow} event
 * @returns {string}
 */
function eventNodeGroupLabel(event) {
    const payload = parseEventPayload(event.payloadJson);
    const nodeId = payload.nodeId;
    if (typeof nodeId === "string" && nodeId.length > 0)
        return nodeId;
    return "(run)";
}
/**
 * @param {EventHistoryRow} event
 * @returns {{ nodeLabel: string; attemptLabel: string; }}
 */
function eventAttemptGroupLabel(event) {
    const payload = parseEventPayload(event.payloadJson);
    const nodeLabel = eventNodeGroupLabel(event);
    const attempt = parseEventNumber(payload.attempt);
    const iteration = parseEventNumber(payload.iteration);
    if (attempt === null && iteration === null) {
        return {
            nodeLabel,
            attemptLabel: "Attempt ?",
        };
    }
    if (iteration === null) {
        return {
            nodeLabel,
            attemptLabel: `Attempt ${attempt ?? "?"}`,
        };
    }
    return {
        nodeLabel,
        attemptLabel: `Attempt ${attempt ?? "?"} (iteration ${iteration})`,
    };
}
/**
 * @param {EventHistoryRow[]} events
 * @param {number} baseMs
 * @param {EventGroupBy} groupBy
 * @returns {string[]}
 */
function renderGroupedEvents(events, baseMs, groupBy) {
    const lines = [];
    if (groupBy === "node") {
        const order = [];
        const grouped = new Map();
        for (const event of events) {
            const key = eventNodeGroupLabel(event);
            if (!grouped.has(key)) {
                grouped.set(key, []);
                order.push(key);
            }
            grouped.get(key).push(event);
        }
        for (const key of order) {
            if (lines.length > 0)
                lines.push("");
            lines.push(pc.bold(`node: ${key}`));
            const bucket = grouped.get(key) ?? [];
            for (const event of bucket) {
                lines.push(`  ${buildEventHistoryLine(event, baseMs)}`);
            }
        }
        return lines;
    }
    const nodeOrder = [];
    const nodeBuckets = new Map();
    for (const event of events) {
        const { nodeLabel, attemptLabel } = eventAttemptGroupLabel(event);
        if (!nodeBuckets.has(nodeLabel)) {
            nodeBuckets.set(nodeLabel, { attemptOrder: [], attempts: new Map() });
            nodeOrder.push(nodeLabel);
        }
        const entry = nodeBuckets.get(nodeLabel);
        if (!entry.attempts.has(attemptLabel)) {
            entry.attempts.set(attemptLabel, []);
            entry.attemptOrder.push(attemptLabel);
        }
        entry.attempts.get(attemptLabel).push(event);
    }
    for (const nodeLabel of nodeOrder) {
        const nodeEntry = nodeBuckets.get(nodeLabel);
        if (!nodeEntry)
            continue;
        if (lines.length > 0)
            lines.push("");
        lines.push(pc.bold(`node: ${nodeLabel}`));
        for (const attemptLabel of nodeEntry.attemptOrder) {
            lines.push(pc.bold(`  ${attemptLabel}`));
            const bucket = nodeEntry.attempts.get(attemptLabel) ?? [];
            for (const event of bucket) {
                lines.push(`    ${buildEventHistoryLine(event, baseMs)}`);
            }
        }
    }
    return lines;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ afterSeq: number; nodeId?: string; eventTypes?: readonly string[]; sinceTimestampMs?: number; limit: number; }} query
 */
async function queryEventHistoryPage(adapter, runId, query) {
    return runPromise(adapter.listEventHistoryEffect(runId, {
        afterSeq: query.afterSeq,
        nodeId: query.nodeId,
        sinceTimestampMs: query.sinceTimestampMs,
        types: query.eventTypes,
        limit: query.limit,
    }).pipe(Effect.annotateLogs({
        runId,
        filters: {
            nodeId: query.nodeId,
            sinceTimestampMs: query.sinceTimestampMs,
            eventTypes: query.eventTypes,
            afterSeq: query.afterSeq,
            limit: query.limit,
        },
    }), Effect.withLogSpan("cli:events")));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ nodeId?: string; eventTypes?: readonly string[]; sinceTimestampMs?: number; }} query
 */
async function countEventHistory(adapter, runId, query) {
    return runPromise(adapter.countEventHistoryEffect(runId, {
        nodeId: query.nodeId,
        sinceTimestampMs: query.sinceTimestampMs,
        types: query.eventTypes,
    }).pipe(Effect.annotateLogs({
        runId,
        filters: {
            nodeId: query.nodeId,
            sinceTimestampMs: query.sinceTimestampMs,
            eventTypes: query.eventTypes,
        },
    }), Effect.withLogSpan("cli:events")));
}
/**
 * @param {SmithersDb} adapter
 * @param {number} limit
 * @param {string | undefined} status
 * @returns {Promise<PsRow[]>}
 */
async function buildPsRows(adapter, limit, status) {
    const runs = await adapter.listRuns(limit, status);
    const rows = [];
    for (const run of runs) {
        const nodes = await adapter.listNodes(run.runId);
        const activeNode = nodes.find((n) => n.state === "in-progress");
        const waitingTimers = run.status === "waiting-timer"
            ? await listWaitingTimers(adapter, run.runId)
            : [];
        const nextTimer = waitingTimers[0];
        const view = await computeRunStateFromRow(adapter, run);
        // Surface pending approval gates so `ps --json` consumers (the OpenClaw /
        // Claude plugins' before-prompt context) can relay gate node ids without
        // a second `inspect` round-trip. Only query the runs that are actually
        // parked on a gate to keep the hot path cheap.
        const pendingApprovals = view.state === "waiting-approval"
            ? (await adapter.listPendingApprovals(run.runId)).map((a) => ({
                nodeId: a.nodeId,
                status: a.status,
            }))
            : [];
        rows.push({
            id: run.runId,
            // Lifecycle-linked parentage (Subflow children and CLI launches
            // with --parent-run-id) so list consumers can build run trees
            // without an `inspect` round-trip per run.
            ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
            workflow: run.workflowName ?? (run.workflowPath ? basename(run.workflowPath) : "—"),
            // Path-first workflow id for CTA probing (mirrors inspect):
            // `.smithers/ui/<id>.tsx` entries are keyed by the file basename,
            // which the display name above need not match. (#26)
            workflowId: run.workflowPath
                ? workflowIdFromPath(run.workflowPath)
                : (run.workflowName ?? undefined),
            // Legacy `ps` consumers key off `status` and expect "finished", so
            // only the derived "succeeded" is renamed; every other derived
            // state passes through unchanged, including stale/orphaned so
            // dead-owner runs never read as "running".
            status: view.state === "succeeded" ? "finished" : view.state,
            dbStatus: run.status,
            state: view.state,
            ...(view.unhealthy ? { unhealthy: view.unhealthy } : {}),
            step: nextTimer
                ? `timer:${nextTimer.nodeId}`
                : activeNode?.label ?? activeNode?.nodeId ?? "—",
            ...(nextTimer
                ? {
                    timer: {
                        id: nextTimer.nodeId,
                        iteration: nextTimer.iteration,
                        firesAt: new Date(nextTimer.firesAtMs).toISOString(),
                        remaining: formatRemainingTimer(nextTimer.firesAtMs - Date.now()),
                    },
                }
                : {}),
            started: run.startedAtMs
                ? formatAge(run.startedAtMs)
                : run.createdAtMs
                    ? formatAge(run.createdAtMs)
                    : "—",
            // Raw epoch ms of terminal time (present only on finished/failed/
            // cancelled runs). Fleet tooling needs time-since-FAILURE, not
            // time-since-start, to judge a failure fresh enough to escalate —
            // `started` above only carries start age.
            ...(run.finishedAtMs ? { finishedAtMs: run.finishedAtMs } : {}),
            // Surface the quota reset time on quota-parked runs so fleet tooling
            // polling `ps --json` can decide when to auto-resume. deriveRunState
            // puts resetAtMs on the blocked view for quota parks.
            ...(view.blocked?.kind === "quota" && typeof view.blocked.resetAtMs === "number"
                ? { resetAtMs: view.blocked.resetAtMs }
                : {}),
            ...(pendingApprovals.length ? { pendingApprovals } : {}),
        });
    }
    return rows;
}
/**
 * @param {PsRow[]} rows
 */
function buildPsCtaCommands(rows) {
    const ctaCommands = [];
    const firstActive = rows.find((r) => r.status === "running");
    const firstWaitingApproval = rows.find((r) => r.status === "waiting-approval");
    const firstWaitingTimer = rows.find((r) => r.status === "waiting-timer");
    if (firstActive) {
        ctaCommands.push({ command: `logs ${firstActive.id}`, description: "Tail active run" });
        ctaCommands.push({ command: `chat ${firstActive.id} --follow`, description: "Watch agent chat" });
    }
    if (firstWaitingApproval) {
        ctaCommands.push({ command: `approve ${firstWaitingApproval.id}`, description: "Approve waiting run" });
    }
    if (firstWaitingTimer) {
        ctaCommands.push({ command: `why ${firstWaitingTimer.id}`, description: "Explain timer wait" });
    }
    if (rows.length > 0) {
        ctaCommands.push({ command: `inspect ${rows[0].id}`, description: "Inspect most recent run" });
    }
    return ctaCommands;
}

// Run statuses on which `approve`/`deny` may still resolve a gate. `failed` is
// included so an operator can approve a still-waiting gate before `up --resume`
// recovery (approveNode never checks run status); only the truly terminal
// statuses (finished/cancelled/continued) are rejected as RUN_NOT_ACTIVE.
const ACTIVE_APPROVAL_RUN_STATUSES = new Set([
    "running",
    "waiting-approval",
    "waiting-event",
    "waiting-timer",
    "failed",
]);
const WAITING_APPROVAL_NODE_STATES = new Set(["waiting-approval", "waiting_approval"]);

/**
 * @param {string} nodeId
 * @param {number | null | undefined} iteration
 * @returns {string}
 */
function approvalTargetKey(nodeId, iteration) {
    // NUL separator so a nodeId that itself contains spaces or digits can never
    // collide with another (nodeId, iteration) pair.
    return `${nodeId}\u0000${iteration ?? 0}`;
}

/**
 * @param {Array<{ nodeId: string; iteration?: number | null }>} targets
 * @returns {string}
 */
function formatApprovalTargetList(targets) {
    return targets.map((target) => `  ${target.nodeId} (iteration ${target.iteration ?? 0})`).join("\n");
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ node?: string; iteration?: number }} options
 * @returns {Promise<
 *   | { ok: true; nodeId: string; iteration: number }
 *   | { ok: false; code: string; message: string; exitCode: number }
 * >}
 */
async function resolveApprovalCommandTarget(adapter, runId, options) {
    const run = await adapter.getRun(runId);
    if (!run) {
        return {
            ok: false,
            code: "RUN_NOT_FOUND",
            message: `Run not found: ${runId}`,
            exitCode: 4,
        };
    }
    const runStatus = String(run.status ?? "unknown");
    if (!ACTIVE_APPROVAL_RUN_STATUSES.has(runStatus)) {
        return {
            ok: false,
            code: "RUN_NOT_ACTIVE",
            message: `Run is not active (status: ${runStatus})`,
            exitCode: 4,
        };
    }

    const matchesTarget = (target) => {
        if (options.node && target.nodeId !== options.node)
            return false;
        if (options.iteration != null && (target.iteration ?? 0) !== options.iteration)
            return false;
        return true;
    };

    const pending = (await adapter.listPendingApprovals(runId)).filter(matchesTarget);
    if (pending.length === 1) {
        const target = pending[0];
        return {
            ok: true,
            nodeId: target.nodeId,
            iteration: target.iteration ?? 0,
        };
    }
    if (pending.length > 1) {
        return {
            ok: false,
            code: "AMBIGUOUS_APPROVAL",
            message: `Multiple pending approvals. Specify --node:\n${formatApprovalTargetList(pending)}`,
            exitCode: 4,
        };
    }

    const waitingNodesRaw = (await adapter.listNodes(runId))
        .filter((node) => WAITING_APPROVAL_NODE_STATES.has(String(node.state ?? "")))
        .filter(matchesTarget);
    // A node can sit in `waiting-approval` with an already-decided approval row
    // when the real blocker is a pending human request (the deferred-state
    // bridge re-parks such nodes). Approving there would report a bogus success
    // and the bridge would just re-park it, so exclude decided rows and point
    // the operator at `smithers human` instead.
    const decidedApprovalKeys = new Set((await adapter.listAllDecidedApprovals(runId)).map((approval) => approvalTargetKey(approval.nodeId, approval.iteration)));
    const waitingNodes = waitingNodesRaw.filter((node) => !decidedApprovalKeys.has(approvalTargetKey(node.nodeId, node.iteration)));
    if (waitingNodes.length === 1) {
        const target = waitingNodes[0];
        return {
            ok: true,
            nodeId: target.nodeId,
            iteration: target.iteration ?? 0,
        };
    }
    if (waitingNodes.length > 1) {
        return {
            ok: false,
            code: "AMBIGUOUS_APPROVAL",
            message: `Multiple waiting approval nodes. Specify --node:\n${formatApprovalTargetList(waitingNodes)}`,
            exitCode: 4,
        };
    }
    if (waitingNodesRaw.length > 0) {
        const target = waitingNodesRaw[0];
        return {
            ok: false,
            code: "APPROVAL_ALREADY_DECIDED",
            message: `Approval for node ${target.nodeId} (iteration ${target.iteration ?? 0}) is already decided; the gate is waiting on a human request. Resolve it with: smithers human inbox (then smithers human answer <requestId> --value <json>)`,
            exitCode: 4,
        };
    }
    return {
        ok: false,
        code: "NO_PENDING_APPROVALS",
        message: options.node
            ? `No pending approval matched node ${options.node} for run: ${runId}`
            : `No pending approvals for run: ${runId}`,
        exitCode: 4,
    };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<InspectSnapshot>}
 */
async function buildInspectSnapshot(adapter, runId, options = {}) {
    const run = await adapter.getRun(runId);
    if (!run) {
        throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`);
    }
    const r = run;
    const nodes = await adapter.listNodes(runId);
    const approvals = await adapter.listPendingApprovals(runId);
    const waitingTimers = await listWaitingTimers(adapter, runId);
    const loops = await adapter.listRalph(runId);
    const ancestry = await adapter.listRunAncestry(runId, 1_000);
    const continuedFromRunIds = ancestry.slice(1).map((row) => row.runId);
    const lineagePageSize = 100;
    const continuedFromVisible = continuedFromRunIds.slice(0, lineagePageSize);
    const continuedFromRemaining = continuedFromRunIds.length > lineagePageSize
        ? continuedFromRunIds.length - lineagePageSize
        : 0;
    let activeDescendantRunId;
    {
        const seen = new Set([runId]);
        let cursor = runId;
        while (true) {
            const child = await adapter.getLatestChildRun(cursor);
            if (!child || !child.runId || seen.has(child.runId))
                break;
            activeDescendantRunId = child.runId;
            seen.add(child.runId);
            cursor = child.runId;
        }
    }
    const steps = nodes.map((n) => ({
        id: n.nodeId,
        state: n.state,
        attempt: n.lastAttempt ?? 0,
        label: n.label ?? n.nodeId,
    }));
    const canonicalNodes = nodes.map((n) => ({
        nodeId: n.nodeId,
        state: n.state,
        attempt: n.lastAttempt ?? 0,
        label: n.label ?? n.nodeId,
    }));
    // On a finished/continued (succeeded) run, any task still in `failed` state is
    // a "masked" child — a continueOnFail task or transient agent failure that was
    // tolerated, so the binary run status reads as a clean success. Surface the
    // count so callers don't have to eyeball every node row. A genuinely `failed`
    // run already reports its error, so don't double-count there. Keys are the
    // canonical state keys (`nodeId::iteration`) so a node failing across loop
    // iterations stays distinct. (#295)
    const isSuccessTerminal = r.status === "finished" || r.status === "continued";
    const failedChildKeys = isSuccessTerminal
        ? nodes.filter((n) => n.state === "failed").map((n) => buildStateKey(n.nodeId, n.iteration))
        : [];
    const pendingApprovals = approvals.map((a) => ({
        nodeId: a.nodeId,
        status: a.status,
        requestedAt: a.requestedAtMs ? new Date(a.requestedAtMs).toISOString() : "—",
    }));
    const loopState = loops.map((l) => ({
        loopId: l.ralphId,
        iteration: l.iteration,
        maxIterations: l.maxIterations,
    }));
    let config = undefined;
    if (r.configJson) {
        try {
            config = JSON.parse(r.configJson);
        }
        catch { }
    }
    let error = undefined;
    if (r.errorJson) {
        try {
            error = JSON.parse(r.errorJson);
        }
        catch { }
    }
    const runState = await computeRunStateFromRow(adapter, run).catch(() => undefined);
    const result = {
        run: {
            id: r.runId,
            workflow: r.workflowName ?? (r.workflowPath ? basename(r.workflowPath) : "—"),
            status: r.status,
            ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}),
            started: r.startedAtMs ? new Date(r.startedAtMs).toISOString() : "—",
            elapsed: r.startedAtMs ? formatElapsedCompact(r.startedAtMs, r.finishedAtMs ?? undefined) : "—",
            ...(r.finishedAtMs ? { finished: new Date(r.finishedAtMs).toISOString() } : {}),
            ...(activeDescendantRunId && activeDescendantRunId !== r.runId
                ? { activeDescendantRunId }
                : {}),
            ...(error ? { error } : {}),
        },
        ...(runState ? { runState } : {}),
        ...(failedChildKeys.length > 0
            ? { failedChildren: failedChildKeys.length, failedChildKeys }
            : {}),
        steps,
        nodes: canonicalNodes,
    };
    if (options.pool) {
        const pool = tallyAttemptPool(await adapter.listAttemptsForRun(runId));
        result.pool = {
            attempts: pool,
            summary: renderAttemptPool(pool),
        };
    }
    if (continuedFromVisible.length > 0) {
        result.run.continuedFrom = continuedFromVisible;
        result.run.continuedFromDisplay = [
            ...continuedFromVisible,
            ...(continuedFromRemaining > 0
                ? [`... (${continuedFromRemaining} more)`]
                : []),
        ].join(" -> ");
    }
    if (pendingApprovals.length > 0) {
        result.approvals = pendingApprovals;
    }
    if (waitingTimers.length > 0) {
        result.timers = waitingTimers.map((timer) => ({
            timerId: timer.nodeId,
            iteration: timer.iteration,
            firesAt: new Date(timer.firesAtMs).toISOString(),
            remaining: formatRemainingTimer(timer.firesAtMs - Date.now()),
        }));
    }
    if (loopState.length > 0) {
        result.loops = loopState;
    }
    if (config) {
        result.config = config;
    }
    const ctaCommands = [
        { command: `logs ${runId}`, description: "Tail run logs" },
        { command: `chat ${runId}`, description: "View agent chat" },
    ];
    if (r.status === "running" ||
        r.status === "waiting-approval" ||
        r.status === "waiting-timer" ||
        r.status === "waiting-event" ||
        r.status === "waiting-quota") {
        ctaCommands.push({ command: `cancel ${runId}`, description: "Cancel run" });
    }
    if (pendingApprovals.length > 0) {
        ctaCommands.push({ command: `approve ${runId}`, description: "Approve pending gate" });
    }
    if (waitingTimers.length > 0) {
        ctaCommands.push({ command: `why ${runId}`, description: "Explain timer wait" });
    }
    if (failedChildKeys.length > 0) {
        const first = parseStateKey(failedChildKeys[0]);
        ctaCommands.push({
            command: `node ${first.nodeId} -r ${runId}${first.iteration > 0 ? ` -i ${first.iteration}` : ""}`,
            description: `Run finished with ${failedChildKeys.length} failed ${failedChildKeys.length === 1 ? "child" : "children"}; inspect`,
        });
    }
    const nextSteps = withAgentNextSteps({
        runId,
        workflowId: r.workflowPath ? workflowIdFromPath(r.workflowPath) : (r.workflowName ?? undefined),
    }, ctaCommands);
    return {
        result,
        ctaCommands: nextSteps.commands,
        ctaDescription: nextSteps.description,
        status: r.status,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {{ runId: string; nodeId: string; iteration: number | undefined; }} options
 * @returns {Promise<NodeSnapshot>}
 */
async function buildNodeSnapshot(adapter, options) {
    const detail = await runPromise(aggregateNodeDetailEffect(adapter, {
        runId: options.runId,
        nodeId: options.nodeId,
        iteration: options.iteration,
    }));
    const run = await adapter.getRun(options.runId);
    return {
        detail,
        status: run?.status,
    };
}
// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const workflowArgs = z.object({
    workflow: z.string().describe("Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file"),
});
// `up` accepts an optional workflow: omit it (or pass --interactive) to pick one
// through the interactive terminal flow instead.
const upArgs = z.object({
    workflow: z.string().optional().describe("Workflow ID (from `smithers workflow list`) or path to a .tsx workflow file (omit with --interactive to pick one)"),
});
const upOptions = z.object({
    detach: z.boolean().default(false).describe("Run in background, print run ID, exit"),
    runId: z.string().optional().describe("Explicit run ID"),
    parentRunId: z.string().optional().describe("Existing run ID to record as this run's parent (persisted lineage, surfaced by inspect/ps and the MCP run tools)"),
    maxConcurrency: z.number().int().min(1).optional().describe("Maximum parallel tasks (default: 4)"),
    root: z.string().optional().describe("Tool sandbox root directory"),
    log: z.boolean().default(true).describe("Enable NDJSON event log file output"),
    logDir: z.string().optional().describe("NDJSON event logs directory"),
    allowNetwork: z.boolean().default(false).describe("Allow bash tool network requests"),
    maxOutputBytes: z.number().int().min(1).optional().describe("Max bytes a single tool call can return"),
    toolTimeoutMs: z.number().int().min(1).optional().describe("Max wall-clock time per tool call in ms"),
    hot: z.boolean().default(false).describe("Enable hot module replacement for .tsx workflows"),
    input: z.string().optional().describe("Input data as JSON string"),
    annotations: z.string().optional().describe("Run annotations as a flat JSON object of string/number/boolean values"),
    resume: z.union([z.boolean(), z.string()]).default(false).describe("Resume a previous run. Pass true with --run-id, or pass the run ID directly (e.g. --resume <run-id>)"),
    force: z.boolean().default(false).describe("Resume even if still marked running"),
    acceptWorkflowChange: z.boolean().default(false).describe("Resume this run after its workflow source changed, re-blessing durability metadata in place; you own replay determinism"),
    resumeClaimOwner: z.string().optional().describe("Internal durable resume claim owner"),
    resumeClaimHeartbeat: z.number().int().min(1).optional().describe("Internal durable resume claim heartbeat"),
    resumeRestoreOwner: z.string().optional().describe("Internal durable resume restore owner"),
    resumeRestoreHeartbeat: z.number().int().min(1).optional().describe("Internal durable resume restore heartbeat"),
    serve: z.boolean().default(false).describe("Start an HTTP server alongside the workflow"),
    supervise: z.boolean().default(false).describe("Run the stale-run supervisor loop (with --serve)"),
    superviseDryRun: z.boolean().default(false).describe("With --supervise, detect stale runs without resuming"),
    superviseInterval: z.string().default("10s").describe("With --supervise, poll interval (e.g. 10s, 30s)"),
    superviseStaleThreshold: z.string().default("30s").describe("With --supervise, stale heartbeat threshold"),
    superviseMaxConcurrent: z.number().int().min(1).default(3).describe("With --supervise, max runs resumed per poll"),
    port: z.number().int().min(1).max(65535).default(7331).describe("HTTP server port (with --serve)"),
    host: z.string().default("127.0.0.1").describe("HTTP server bind address (with --serve)"),
    authToken: z.string().optional().describe("Bearer token for HTTP auth (or set SMITHERS_API_KEY); required to bind a non-loopback --host"),
    insecure: z.boolean().default(false).describe("Allow binding a non-loopback --host with NO auth (exposes unauthenticated approve/deny/cancel control of the run — dangerous)"),
    metrics: z.boolean().default(true).describe("Expose /metrics endpoint (with --serve)"),
    backend: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Bootstrap storage selection for a workflow owner or workspace Gateway; not a run-discovery/control flag"),
    postFailure: z.boolean().default(true).describe("Auto-launch the post-failure autopsy workflow when this run fails (disable with --no-post-failure or SMITHERS_POST_FAILURE=0)"),
    verbose: z.boolean().default(false).describe("Show engine info logs (run lifecycle, agent sessions) on interactive runs; the default keeps progress lines + warnings only. Non-TTY/structured output always gets full logs."),
    report: z.boolean().default(true).describe("On an interactive run, narrate the result with a cheap/fast agent and open an HTML summary in the browser when it finishes (disable with --no-report or SMITHERS_NO_REPORT=1)."),
});
// Launch the interactive picker + live status card instead of a one-shot run.
// Shared by `up` and `workflow run`; deliberately NOT folded into `upOptions`
// so it does not leak onto other commands that extend `upOptions`.
const interactiveRunOption = z
    .boolean()
    .default(false)
    .describe("Pick a workflow and its inputs through interactive terminal prompts, then launch the full-screen TUI monitor for the run (TTY only)");
const upRunOptions = upOptions.extend({ interactive: interactiveRunOption });
const evalOptions = z.object({
    cases: z.string().describe("JSON or JSONL eval case file"),
    suite: z.string().optional().describe("Stable suite ID used in run IDs and report paths"),
    runLabel: z.string().optional().describe("Run label appended to eval run IDs; defaults to current UTC timestamp plus a nonce"),
    dryRun: z.boolean().default(false).describe("Plan the suite without launching runs"),
    concurrency: z.number().int().min(1).max(16).default(1).describe("Number of eval cases to run at once"),
    maxCases: z.number().int().min(1).optional().describe("Run only the first N cases"),
    report: z.string().optional().describe("Write report JSON to this path"),
    force: z.boolean().default(false).describe("Overwrite an existing eval report"),
    includeOutput: z.boolean().default(true).describe("Include workflow outputs in the report"),
    maxConcurrency: z.number().int().min(1).optional().describe("Per-workflow max task concurrency"),
    root: z.string().optional().describe("Tool sandbox root directory"),
    log: z.boolean().default(true).describe("Enable NDJSON event log file output"),
    logDir: z.string().optional().describe("NDJSON event logs directory"),
    allowNetwork: z.boolean().default(false).describe("Allow bash tool network requests"),
    maxOutputBytes: z.number().int().min(1).optional().describe("Max bytes a single tool call can return"),
    toolTimeoutMs: z.number().int().min(1).optional().describe("Max wall-clock time per tool call in ms"),
    optimization: z.string().optional().describe("Apply a Smithers optimization artifact while running the eval suite"),
    judgeProvider: z.enum(EVAL_JUDGE_PROVIDER_IDS).default("auto").describe("Agent provider for LLM-judge assertions"),
    judgeModel: z.string().optional().describe("Model override for LLM-judge assertions"),
});
const superviseOptions = z.object({
    run: z.string().optional().describe("Only supervise these run IDs (comma-separated)"),
    all: z.boolean().default(false).describe("Explicitly supervise every eligible run in the workspace"),
    dryRun: z.boolean().default(false).describe("Show which stale runs would be resumed, without acting"),
    interval: z.string().default("10s").describe("Poll interval (e.g. 10s, 30s, 1m)"),
    staleThreshold: z.string().default("30s").describe("Heartbeat staleness threshold before resume"),
    maxConcurrent: z.number().int().min(1).default(3).describe("Max runs resumed per poll"),
});
const gatewayArgs = z.object({
    action: z.enum(["status", "stop"]).optional().describe("Manage the workspace's singleton gateway instead of serving one: status | stop"),
});
const gatewayOptions = z.object({
    host: z.string().default("127.0.0.1").describe("Gateway bind address"),
    port: z.number().int().min(1).max(65535).default(7331).describe("Preferred gateway port (falls back to an ephemeral port when taken; clients discover the verified URL with gateway status)"),
    backend: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Storage behind this workspace Gateway; a boot/deployment choice, not a client run-lookup flag"),
    authToken: z.string().optional().describe("Bearer token for HTTP/WS auth (or set SMITHERS_API_KEY); required to bind a non-loopback --host"),
    mintToken: z.boolean().default(false).describe("Mint a random bearer token, require it on every request, and record it only in the 0600 runtime state file"),
    insecure: z.boolean().default(false).describe("Allow binding a non-loopback --host with NO auth (exposes a full-control, unauthenticated control plane — dangerous)"),
    idleTimeout: z.number().int().min(0).optional().describe("Exit after this many ms with no clients, in-flight runs, or registered schedules (0 = stay up; autostarted daemons set this automatically). Overridable via SMITHERS_GATEWAY_IDLE_MS."),
});
const migrateOptions = z.object({
    from: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Source backend; inferred when exactly one store has runs"),
    to: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Target backend; required (pglite, postgres, or sqlite)"),
    url: z.string().optional().describe("Postgres connection URL when --to postgres"),
    keepSqlite: z.boolean().default(true).describe("Keep the legacy SQLite database after a successful copy"),
    agent: z.boolean().default(false).describe("Run the durable migrate-repair workflow instead of deterministic migration"),
});
const bugOptions = z.object({
    run: z.string().optional().describe("Attach this run's workflow name, status, error, and recent events to the report"),
    title: z.string().optional().describe("Bug title (derived from the run's error when omitted)"),
    body: z.string().optional().describe("Bug description body"),
    endpoint: z.string().optional().describe("Bug endpoint URL (default https://bug.smithers.sh/api/bugs; the SMITHERS_BUG_ENDPOINT env var takes precedence)"),
});
const psOptions = z.object({
    status: z.string().optional().describe("Filter by status: running, waiting-approval, waiting-event, waiting-timer, paused, continued, finished, failed, cancelled"),
    limit: z.number().int().min(1).default(20).describe("Maximum runs to return"),
    all: z.boolean().default(false).describe("Include all statuses"),
    watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
    interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
});
// `--since` historically meant an event SEQUENCE NUMBER here while the sibling
// `events --since` takes a DURATION window — the same token silently means two
// different things. `--from-seq` is the preferred spelling for the cursor;
// `--since` stays accepted as a deprecated alias so existing scripts keep
// working. (#10)
const logsOptions = z.object({
    follow: z.boolean().default(true).describe("Keep tailing (default true for active runs)"),
    fromSeq: z.number().int().optional().describe("Start from event sequence number (exclusive)"),
    since: z.number().int().optional().describe("Deprecated alias of --from-seq: an event SEQUENCE NUMBER, not a duration (`events --since` takes a duration window like 5m)"),
    tail: z.number().int().min(1).default(50).describe("Show last N events first"),
    followAncestry: z.boolean().default(false).describe("Include events from ancestor runs (continuation lineage)"),
});
const eventsOptions = z.object({
    node: z.string().optional().describe("Filter events by node ID"),
    type: z.string().optional().describe(`Filter by event category (${[...EVENT_CATEGORY_VALUES].sort().join(", ")})`),
    since: z.string().optional().describe("Filter to a recent duration window (e.g. 5m, 2h; a bare number is milliseconds, and `logs --since` is an event sequence number instead)"),
    limit: z.number().int().min(1).optional().describe("Maximum events to display (default 1000, max 100000)"),
    json: z.boolean().default(false).describe("Output NDJSON for piping"),
    groupBy: z.string().optional().describe("Group output by \"node\" or \"attempt\""),
    watch: z.boolean().default(false).describe("Watch mode: append new events as they arrive"),
    interval: z.number().positive().default(2).describe("Watch poll interval in seconds"),
    raw: z.boolean().default(false).describe("Include raw agent chunk/tool history instead of the default lifecycle-only view"),
});
const chatArgs = z.object({
    runId: z.string().optional().describe("Run ID to inspect (default: latest run)"),
});
const chatOptions = z.object({
    all: z.boolean().default(false).describe("Show all agent attempts in the run (default: latest only)"),
    follow: z.boolean().default(false).describe("Watch for new agent output"),
    tail: z.number().int().min(1).optional().describe("Show only the last N chat blocks"),
    stderr: z.boolean().default(true).describe("Include agent stderr output"),
});
const chatCreateOptions = z.object({
    agent: z.enum(INLINE_CHAT_ENGINES).describe("CLI agent engine to launch"),
    cwd: z.string().optional().describe("Working directory for the chat session (default: current directory)"),
});
const inspectArgs = z.object({
    runId: z.string().describe("Run ID to inspect"),
});
const inspectOptions = z.object({
    watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
    interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
    pool: z.boolean().default(false).describe("Tally attempts by agent engine/model"),
});
const nodeArgs = z.object({
    nodeId: z.string().describe("Node ID to inspect"),
});
const nodeOptions = z.object({
    runId: z.string().describe("Run ID containing the node"),
    iteration: z.number().int().min(0).optional().describe("Loop iteration number (default: latest iteration)"),
    attempts: z.boolean().default(false).describe("Expand all attempts in human output"),
    tools: z.boolean().default(false).describe("Expand tool input/output payloads in human output"),
    watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
    interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
});
const whyArgs = z.object({
    runId: z.string().describe("Run ID to explain"),
});
const whyOptions = z.object({
    json: z.boolean().default(false).describe("Output structured JSON diagnosis"),
});
const statusArgs = z.object({
    runId: z.string().describe("Run ID to summarize"),
});
const statusOptions = z.object({
    json: z.boolean().default(false).describe("Output the structured summary as JSON"),
    window: z.number().positive().optional().describe("Recent-activity window in minutes for the throughput/verdict checks (default 10)"),
});
const whatArgs = z.object({
    runId: z.string().optional().describe("Run ID to explain (default: latest run)"),
});
const whatOptions = z.object({
    node: z.string().optional().describe("Node ID: explain one node instead of the whole run"),
    iteration: z.number().int().min(0).optional().describe("Loop iteration number (default: latest iteration)"),
    json: z.boolean().default(false).describe("Output structured JSON (summary, agentId, source, facts)"),
    timeout: z.number().positive().optional().describe("Narrator agent timeout in seconds (default 60)"),
});
const approveArgs = z.object({
    runId: z.string().describe("Run ID containing the approval gate"),
});
const approveOptions = z.object({
    node: z.string().optional().describe("Node ID (required if multiple pending)"),
    iteration: z.number().int().min(0).optional().describe("Loop iteration number (defaults to the pending gate's iteration)"),
    note: z.string().optional().describe("Approval/denial note"),
    by: z.string().optional().describe("Name or identifier of the approver"),
});
const humanArgs = z.object({
    action: z.string().describe("Human request action: inbox, answer, or cancel"),
    requestId: z.string().optional().describe("Human request ID for answer/cancel"),
});
const humanOptions = z.object({
    value: z.string().optional().describe("JSON response for smithers human answer"),
    by: z.string().optional().describe("Name or identifier of the human operator"),
});
const askHumanArgs = z.object({
    prompt: z.string().describe("The decision or question to put to a human"),
});
const askHumanOptions = z.object({
    context: z.string().optional().describe("Extra context appended to the prompt"),
    choices: z.string().optional().describe("Comma-separated choices; makes this a fixed-choice decision"),
    runId: z.string().optional().describe("Run to attach to (default: SMITHERS_RUN_ID or the single active run)"),
    node: z.string().optional().describe("Node id to attach to (default: SMITHERS_NODE_ID or 'agent-ask')"),
    iteration: z.number().int().min(0).optional().describe("Loop iteration (default: SMITHERS_ITERATION or 0)"),
    timeout: z.number().min(0).optional().describe("Seconds to wait before the request expires (0/unset = no timeout)"),
    poll: z.number().min(0.25).optional().describe("Poll interval in seconds while blocking (default 3)"),
});
const alertsArgs = z.object({
    action: z.string().describe("Alert action: list, ack, resolve, or silence"),
    alertId: z.string().optional().describe("Alert ID for ack/resolve/silence"),
});
const alertsOptions = z.object({});
const signalArgs = z.object({
    runId: z.string().describe("Run ID containing the waiting signal"),
    signalName: z.string().describe("Signal name to deliver"),
});
const signalOptions = z.object({
    data: z.string().optional().describe("Signal payload as JSON (default: {})"),
    correlation: z.string().optional().describe("Correlation ID to match a specific waiter"),
    by: z.string().optional().describe("Name or identifier of the signal sender"),
});
const cancelArgs = z.object({
    runId: z.string().describe("Run ID to cancel"),
});
const pauseArgs = z.object({
    runId: z.string().describe("Run ID to pause"),
});
const hijackArgs = z.object({
    runId: z.string().describe("Run ID whose latest agent session should be hijacked"),
});
const hijackOptions = z.object({
    target: z.string().optional().describe("Agent engine (e.g. claude-code, codex) or node id whose session to hand off"),
    timeoutMs: z.number().int().min(1).default(30_000).describe("How long to wait for a live run to hand off"),
    launch: z.boolean().default(true).describe("Open the hijacked session immediately"),
});
const graphOptions = z.object({
    runId: z.string().default("graph").describe("Run ID for context"),
    input: z.string().optional().describe("Input data as JSON"),
    root: z.string().optional().describe("Tool sandbox root directory (same semantics as `up`)"),
    compact: z.boolean().default(false).describe("Omit task prompt/text bodies (structure only) — validate that a workflow compiles without flooding output with every prompt"),
});
const revertOptions = z.object({
    runId: z.string().describe("Run ID to revert"),
    nodeId: z.string().describe("Node ID to revert to"),
    attempt: z.number().int().min(1).default(1).describe("Attempt number"),
    iteration: z.number().int().min(0).default(0).describe("Loop iteration number"),
});
const workflowPathArgs = z.object({
    name: z.string().describe("Workflow ID"),
});
// `workflow run` accepts an optional ID: omit it (or pass --interactive) to pick
// a workflow through the interactive terminal flow instead.
const workflowRunArgs = z.object({
    name: z.string().optional().describe("Workflow ID (omit with --interactive to pick one)"),
});
const workflowDoctorArgs = z.object({
    name: z.string().optional().describe("Workflow ID"),
});
const workflowSkillArgs = z.object({
    name: z.string().optional().describe("Workflow ID, or omit to generate skills for all workflows"),
});
const workflowSkillOptions = z.object({
    output: z.string().optional().describe("Output file for one workflow, or output directory for all workflows"),
    force: z.boolean().default(false).describe("Overwrite existing skill files"),
    global: z.boolean().default(false).describe("Write skills into the global ~/.smithers pack (honors SMITHERS_HOME) instead of the local .smithers"),
});
const workflowListOptions = z.object({
    system: z.boolean().default(false).describe("Include system workflows (internal plumbing hidden from the default listing)"),
});
const workflowCreateOptions = z.object({
    global: z.boolean().default(false).describe("Create the workflow in the global ~/.smithers pack (honors SMITHERS_HOME) instead of the local .smithers"),
});
const workflowRunOptions = upOptions.extend({
    prompt: z.string().optional().describe("Prompt text mapped to input.prompt when --input is omitted"),
    interactive: interactiveRunOption,
});
const packSpecArgs = z.object({ spec: z.string().describe("GitHub, npm, or file pack spec") });
const packNameArgs = z.object({ name: z.string().describe("Installed pack name") });
const packWorkflowArgs = z.object({ spec: z.string().describe("Pack workflow in the form <pack>:<workflow>") });
const packOptions = z.object({ global: z.boolean().default(false).describe("Install in ~/.smithers/packs instead of the local project"), yes: z.boolean().default(false).describe("Skip trust confirmation") });
const upgradeOptions = z.object({
    interactive: z.boolean().default(false).describe("Force the full-screen interactive TUI monitor (TTY only)."),
    detach: z.boolean().default(false).describe("Launch the upgrade workflow in the background and print the run ID."),
    dryRun: z.boolean().default(false).describe("Fetch changelogs and plan the upgrade without changing the install."),
    runId: z.string().optional().describe("Explicit run ID for the upgrade workflow."),
    root: z.string().optional().describe("Tool sandbox root directory."),
    logDir: z.string().optional().describe("NDJSON event logs directory."),
    backend: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Storage backend for the upgrade workflow run."),
    authToken: z.string().optional().describe("Bearer token passed to the interactive monitor gateway client."),
});
/**
 * @param {WorkflowRunCommandOptions} options
 * @returns {UpCommandOptions}
 */
function normalizeWorkflowRunOptions(options) {
    // `root` intentionally flows through untouched (no "." default): `workflow
    // run` and `up <path>` now share resolveLaunchRootDir, which anchors to the
    // project root rather than the operator CWD. (#283)
    return {
        ...options,
        input: options.input ??
            (options.prompt !== undefined
                ? JSON.stringify({ prompt: options.prompt })
                : undefined),
    };
}
/**
 * Decide how a run command (`up` / `workflow run`) should launch:
 *   - "interactive" — show the clack picker + live status card (explicit
 *     --interactive, or no workflow given while attached to a TTY).
 *   - "direct" — run the named/path workflow non-interactively (the default).
 *   - "needs-tty" — --interactive was requested without an interactive terminal.
 *   - "missing-arg" — no workflow given and not a TTY, so there is nothing to run.
 *
 * A machine-output request must never open interactive prompts: on a PTY the
 * clack intro/picker bytes would interleave with the structured stdout stream
 * and the picker would block waiting for keys. Any explicitly requested
 * non-default format (`--format json|jsonl|yaml|md`, or the global `--json`
 * shorthand, all of which resolve to a non-toon `c.format`) therefore forces
 * the non-interactive branches even when attached to a TTY. (#19)
 *
 * @param {{ interactive?: boolean }} options
 * @param {boolean} hasWorkflowArg
 * @param {string} [format] resolved output format (`c.format`)
 * @returns {"interactive" | "direct" | "needs-tty" | "missing-arg"}
 */
function interactiveLaunchMode(options, hasWorkflowArg, format) {
    const wantsStructured = format !== undefined && format !== "toon";
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !wantsStructured;
    if (options.interactive) return tty ? "interactive" : "needs-tty";
    if (!hasWorkflowArg) return tty ? "interactive" : "missing-arg";
    return "direct";
}
/**
 * @param {{ interactive?: boolean; detach?: boolean }} options
 * @param {string | undefined} format
 * @returns {"interactive" | "detached" | "needs-tty"}
 */
function upgradeLaunchMode(options, format) {
    const wantsStructured = format !== undefined && format !== "toon";
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !wantsStructured;
    if (options.interactive) return tty ? "interactive" : "needs-tty";
    if (options.detach || wantsStructured || !tty || isAgentHarness()) return "detached";
    return "interactive";
}
/**
 * @param {any} options
 * @param {boolean} detach
 * @returns {any}
 */
function buildUpgradeUpOptions(options, detach) {
    return {
        ...upOptions.parse({}),
        detach,
        runId: options.runId,
        root: options.root,
        logDir: options.logDir,
        backend: options.backend,
        authToken: options.authToken,
        input: JSON.stringify({ dryRun: options.dryRun }),
        // The upgrade workflow itself is the status report; avoid launching the
        // post-run HTML narrator from the detached child.
        report: false,
    };
}
function formatRequestedJsonOutput() {
    for (let index = 0; index < process.argv.length; index += 1) {
        const arg = process.argv[index];
        if (arg === "--format") {
            const value = process.argv[index + 1];
            return value === "json" || value === "jsonl";
        }
        if (arg === "--format=json" || arg === "--format=jsonl") {
            return true;
        }
    }
    return false;
}
function defaultEvalRunLabel() {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}
/**
 * Resolve a workflow argument that may be either a `.tsx` file path or a
 * discovered workflow ID (as printed by `smithers workflow list`). Existing
 * files are returned verbatim; otherwise the arg is treated as an ID and
 * resolved to its entry file. Keeps `graph`/`up`/`eval`/`optimize` consistent
 * with `workflow run`, which has always accepted IDs.
 *
 * @param {string} workflowInput
 */
function resolveWorkflowArg(workflowInput) {
    const asPath = resolve(process.cwd(), workflowInput);
    if (existsSync(asPath)) {
        return workflowInput;
    }
    return resolveWorkflow(workflowInput, process.cwd()).entryFile;
}
/**
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runWithLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    }));
    return results;
}
/**
 * @param {string} intervalRaw
 * @param {string} staleThresholdRaw
 * @param {number} maxConcurrent
 * @param {boolean} dryRun
 */
function resolveSupervisorOptions(intervalRaw, staleThresholdRaw, maxConcurrent, dryRun) {
    const pollIntervalMs = parseDurationMs(intervalRaw, "interval");
    const staleThresholdMs = parseDurationMs(staleThresholdRaw, "stale-threshold");
    return {
        dryRun,
        pollIntervalMs,
        staleThresholdMs,
        maxConcurrent,
    };
}
/**
 * @param {UpCommandOptions} options
 */
function validateUpOptionConsistency(options) {
    if (options.supervise && !options.serve && !options.detach) {
        return {
            code: "SUPERVISE_REQUIRES_DETACH_OR_SERVE",
            message: "--supervise on `smithers up` requires --detach or --serve. Use `smithers supervise --run <id>` for standalone mode.",
            exitCode: 4,
        };
    }
    if (Boolean(options.resumeClaimOwner) !== Boolean(options.resumeClaimHeartbeat)) {
        return {
            code: "INVALID_RESUME_CLAIM",
            message: "--resume-claim-owner and --resume-claim-heartbeat must be provided together.",
            exitCode: 4,
        };
    }
    if (options.parentRunId !== undefined) {
        if (options.parentRunId.trim() === "") {
            return {
                code: "INVALID_PARENT_RUN",
                message: "--parent-run-id must be a non-empty run ID.",
                exitCode: 4,
            };
        }
        // Parent lineage is persisted once, when the child run row is created.
        // A resume re-attaches to that existing row, so a conflicting
        // --parent-run-id would be silently ignored — reject it instead.
        if (options.resume) {
            return {
                code: "PARENT_RUN_WITH_RESUME",
                message: "--parent-run-id can only be set when creating a run; --resume keeps the parent recorded at creation.",
                exitCode: 4,
            };
        }
        if (options.runId && options.parentRunId === options.runId) {
            return {
                code: "INVALID_PARENT_RUN",
                message: "--parent-run-id cannot equal the run's own --run-id.",
                exitCode: 4,
            };
        }
    }
    return null;
}
/**
 * Confirm a declared --parent-run-id exists in the workspace store before the
 * child run launches. The detached path must fail loud in the foreground
 * parent process — otherwise a dangling lineage error would only surface in
 * the detached child's log file.
 *
 * @param {string} parentRunId
 * @returns {Promise<{ code: string; message: string; exitCode: number } | null>}
 */
async function findParentRunError(parentRunId) {
    let opened;
    try {
        opened = await findAndOpenDb();
    }
    catch (err) {
        // A workspace without a store cannot contain the parent run.
        if (err instanceof SmithersError && err.code === "CLI_DB_NOT_FOUND") {
            return {
                code: "PARENT_RUN_NOT_FOUND",
                message: `Parent run not found: ${parentRunId} (no smithers store exists in this workspace yet)`,
                exitCode: 4,
            };
        }
        throw err;
    }
    try {
        const parentRun = await opened.adapter.getRun(parentRunId);
        if (!parentRun) {
            return {
                code: "PARENT_RUN_NOT_FOUND",
                message: `Parent run not found: ${parentRunId}`,
                exitCode: 4,
            };
        }
        return null;
    }
    finally {
        opened.cleanup?.();
    }
}
/**
 * @param {EventsCommandOptions} options
 * @returns {NormalizedEventsQuery}
 */
function normalizeEventsQuery(options) {
    const jsonRequested = Boolean(options.json) || process.argv.includes("--json");
    const groupBy = normalizeEventGroupBy(options.groupBy);
    let typeName;
    let eventTypes;
    if (options.type) {
        const category = normalizeEventCategory(options.type);
        if (!category) {
            throw new SmithersError("INVALID_EVENT_TYPE_FILTER", `Invalid --type value "${options.type}". Allowed categories: ${[...EVENT_CATEGORY_VALUES].sort().join(", ")}`);
        }
        typeName = category;
        eventTypes = eventTypesForCategory(category);
    }
    else if (!options.raw) {
        eventTypes = DEFAULT_LIFECYCLE_EVENT_TYPES;
    }
    let sinceTimestampMs;
    if (options.since) {
        const sinceDurationMs = parseDurationMs(options.since, "since");
        sinceTimestampMs = Date.now() - sinceDurationMs;
    }
    const limitInfo = normalizeEventsLimit(options.limit);
    return {
        nodeId: options.node,
        typeName,
        eventTypes,
        sinceTimestampMs,
        groupBy,
        json: jsonRequested,
        limit: limitInfo.value,
        defaultLimitUsed: limitInfo.defaultLimitUsed,
        limitCapped: limitInfo.limitCapped,
    };
}
/**
 * @param {{ ok: (...args: any[]) => any }} c
 * @param {string} workflowPath
 * @param {UpCommandOptions} options
 * @param {FailFn} fail
 */
async function executeUpCommand(c, workflowPath, options, fail) {
    const detachedLogFile = process.env[DETACHED_RUN_LOG_FILE_ENV];
    delete process.env[DETACHED_RUN_LOG_FILE_ENV];
    try {
        let input;
        let annotations;
        try {
            input = parseJsonArgument(options.input, "input") ?? {};
            const parsedAnnotations = parseJsonArgument(options.annotations, "annotations");
            if (parsedAnnotations === undefined) {
                annotations = undefined;
            }
            else if (!parsedAnnotations || typeof parsedAnnotations !== "object" || Array.isArray(parsedAnnotations)) {
                return fail({
                    code: "INVALID_ANNOTATIONS",
                    message: "Run annotations must be a flat JSON object of string/number/boolean values",
                    exitCode: 4,
                });
            }
            else {
                annotations = {};
                for (const [key, value] of Object.entries(parsedAnnotations)) {
                    if (!["string", "number", "boolean"].includes(typeof value)) {
                        return fail({
                            code: "INVALID_ANNOTATIONS",
                            message: `Run annotation ${key} must be a string, number, or boolean`,
                            exitCode: 4,
                        });
                    }
                    annotations[key] = /** @type {string | number | boolean} */ (value);
                }
            }
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError ? err.code : "INVALID_JSON",
                message: err?.message ?? String(err),
                exitCode: 4,
            });
        }
        const optionError = validateUpOptionConsistency(options);
        if (optionError)
            return fail(optionError);
        try {
            workflowPath = resolveWorkflowArg(workflowPath);
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: 4 });
            }
            throw err;
        }
        const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
        const { resume, resumeRunId } = normalizeResumeOption(options.resume);
        const runId = options.runId ?? resumeRunId;
        // Detached mode: spawn ourselves as a background process
        if (options.detach) {
            // Validate the declared parent BEFORE spawning: the detached child
            // would otherwise fail in the background with nothing on the
            // caller's terminal but a runId that never appears in `ps`.
            if (options.parentRunId) {
                const parentError = await findParentRunError(options.parentRunId);
                if (parentError)
                    return fail(parentError);
            }
            const cliPath = fileURLToPath(import.meta.url);
            const childArgs = ["up", workflowPath];
            if (runId)
                childArgs.push("--run-id", runId);
            if (options.parentRunId)
                childArgs.push("--parent-run-id", options.parentRunId);
            if (options.input)
                childArgs.push("--input", options.input === "-" ? JSON.stringify(input) : options.input);
            if (options.annotations)
                childArgs.push("--annotations", options.annotations === "-" ? JSON.stringify(annotations ?? {}) : options.annotations);
            if (options.maxConcurrency)
                childArgs.push("--max-concurrency", String(options.maxConcurrency));
            if (options.root)
                childArgs.push("--root", options.root);
            if (!options.log)
                childArgs.push("--no-log");
            if (options.logDir)
                childArgs.push("--log-dir", options.logDir);
            if (options.allowNetwork)
                childArgs.push("--allow-network");
            if (options.maxOutputBytes)
                childArgs.push("--max-output-bytes", String(options.maxOutputBytes));
            if (options.toolTimeoutMs)
                childArgs.push("--tool-timeout-ms", String(options.toolTimeoutMs));
            if (options.hot)
                childArgs.push("--hot");
            if (resume)
                childArgs.push("--resume");
            if (options.force)
                childArgs.push("--force");
            if (options.acceptWorkflowChange)
                childArgs.push("--accept-workflow-change");
            if (options.resumeClaimOwner)
                childArgs.push("--resume-claim-owner", options.resumeClaimOwner);
            if (options.resumeClaimHeartbeat)
                childArgs.push("--resume-claim-heartbeat", String(options.resumeClaimHeartbeat));
            if (options.resumeRestoreOwner)
                childArgs.push("--resume-restore-owner", options.resumeRestoreOwner);
            if (options.resumeRestoreHeartbeat)
                childArgs.push("--resume-restore-heartbeat", String(options.resumeRestoreHeartbeat));
            if (options.serve)
                childArgs.push("--serve");
            if (options.supervise && options.serve)
                childArgs.push("--supervise");
            if (options.superviseDryRun)
                childArgs.push("--supervise-dry-run");
            if (options.superviseInterval !== "10s")
                childArgs.push("--supervise-interval", options.superviseInterval);
            if (options.superviseStaleThreshold !== "30s")
                childArgs.push("--supervise-stale-threshold", options.superviseStaleThreshold);
            if (options.superviseMaxConcurrent !== 3)
                childArgs.push("--supervise-max-concurrent", String(options.superviseMaxConcurrent));
            if (options.serve && options.port !== 7331)
                childArgs.push("--port", String(options.port));
            if (options.serve && options.host !== "127.0.0.1")
                childArgs.push("--host", options.host);
            if (options.authToken)
                childArgs.push("--auth-token", options.authToken);
            if (options.serve && !options.metrics)
                childArgs.push("--metrics", "false");
            if (options.backend)
                childArgs.push("--backend", options.backend);
            if (options.postFailure === false)
                childArgs.push("--no-post-failure");
            const effectiveRunId = runId ?? `run-${Date.now()}`;
            await reapDetachedRunLogs({ cwd: cliWorkspace.cwd() });
            const logFile = resolveDetachedRunLogFile(effectiveRunId, {
                logDir: options.logDir,
                cwd: cliWorkspace.cwd(),
            });
            mkdirSync(dirname(logFile), { recursive: true });
            if (!runId)
                childArgs.push("--run-id", effectiveRunId);
            const fd = openSync(logFile, "a");
            const child = spawn("bun", [cliPath, ...childArgs], {
                detached: true,
                stdio: ["ignore", fd, fd],
                env: { ...process.env, [DETACHED_RUN_LOG_FILE_ENV]: logFile },
            });
            child.unref();
            let supervisorPid;
            if (options.supervise && !options.serve) {
                const supervisorArgs = [cliPath, "supervise", "--run", effectiveRunId];
                if (options.superviseDryRun)
                    supervisorArgs.push("--dry-run");
                if (options.superviseInterval !== "10s")
                    supervisorArgs.push("--interval", options.superviseInterval);
                if (options.superviseStaleThreshold !== "30s")
                    supervisorArgs.push("--stale-threshold", options.superviseStaleThreshold);
                if (options.superviseMaxConcurrent !== 3)
                    supervisorArgs.push("--max-concurrent", String(options.superviseMaxConcurrent));
                const supervisor = spawn("bun", supervisorArgs, {
                    detached: true,
                    stdio: ["ignore", fd, fd],
                    env: process.env,
                });
                supervisor.unref();
                supervisorPid = supervisor.pid;
            }
            // A run detached from inside a Claude Code session should notify
            // that session's background monitor (approvals, failures, stalls).
            subscribeClaudeSessionRun(effectiveRunId);
            const monitorWorkflowId = workflowIdFromPath(workflowPath);
            const monitorHasUi = hasCustomUi(monitorWorkflowId, process.cwd());
            const monitoring = buildMonitoringGuidance({
                runId: effectiveRunId,
                workflowId: monitorWorkflowId,
                hasUi: monitorHasUi,
            });
            const monitorCommands = monitorHasUi
                ? [{ command: `ui ${effectiveRunId}`, description: "Open the live workflow UI" }]
                : [];
            // The monitoring guidance already covers the custom-UI suggestion,
            // so the shared next steps skip it here (omitUi) to avoid repeats.
            const backgroundCta = withAgentNextSteps({
                workflowId: monitorWorkflowId,
                workflowFile: workflowPath,
                runId: effectiveRunId,
                hasUi: monitorHasUi,
                omitUi: true,
            }, [
                ...monitorCommands,
                { command: `logs ${effectiveRunId}`, description: "Tail run logs" },
                { command: `chat ${effectiveRunId} --follow`, description: "Watch agent chat" },
                { command: `ps`, description: "List all runs" },
                { command: `inspect ${effectiveRunId}`, description: "Inspect run state" },
            ], `${monitoring.text}\n\nOperate the run:`);
            return c.ok({ runId: effectiveRunId, logFile, pid: child.pid, ...(supervisorPid ? { supervisorPid } : {}), monitoring }, {
                cta: backgroundCta,
            });
        }
        if (options.hot) {
            process.env.SMITHERS_HOT = "1";
        }
        // Human-facing one-shot runs default the engine to warn-level logs: the
        // progress reporter already narrates lifecycle, and info-level logs dump
        // the full agent prompt/args over a first `workflow run hello`. Scoped
        // AFTER the detach branch so a detached child's log file keeps full
        // detail. Piped/structured output, an explicit SMITHERS_LOG_LEVEL, and
        // --verbose all keep full logs.
        const humanTty = Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
            (c.format === undefined || c.format === "toon");
        if (humanTty && !options.verbose && process.env.SMITHERS_LOG_LEVEL === undefined) {
            process.env.SMITHERS_LOG_LEVEL = "warn";
        }
        if (options.backend) {
            process.env.SMITHERS_BACKEND = options.backend;
        }
        const workflow = await loadWorkflow(workflowPath);
        // If the workspace has been migrated to pglite (backend.json says pglite)
        // but this workflow was authored with the synchronous createSmithers()
        // bun:sqlite factory, fail loud. Silently swapping its db to the async
        // pglite store deadlocks the sync engine (a run never completes), and
        // degrading to the leftover sqlite file is forbidden — createSmithers is
        // the sqlite-only path ("never silently degrade"; the `--backend pglite`
        // path rejects it for the same reason). The fix is to re-author the
        // workflow with the async `openSmithersBackend` factory.
        if (!options.backend && !process.env.SMITHERS_BACKEND) {
            const markerBackend = readBackendMarkerForCwd(process.cwd());
            // A createSmithers (sqlite) workflow exposes its bun:sqlite handle as
            // `db.$client`; an `openSmithersBackend` (pglite/postgres) workflow
            // does not, and manages its own backend, so leave those untouched.
            const isSqliteWorkflow = Boolean(workflow.db?.$client);
            if (markerBackend === "pglite" && isSqliteWorkflow) {
                // Open the authoritative pglite store first so a broken store is
                // reported as such (rather than masking it behind the mismatch).
                let probe;
                try {
                    const { openSmithersBackend } = await import("smithers-orchestrator");
                    // Validate the authoritative pglite store actually opens (so a
                    // genuinely broken store surfaces as BACKEND_OPEN_FAILED rather
                    // than being masked by the BACKEND_MISMATCH below). No schemas
                    // are needed: this workflow cannot serve pglite regardless, so
                    // the store is only probed, then closed.
                    probe = await openSmithersBackend({}, { backend: "pglite" });
                }
                catch (err) {
                    return fail({
                        code: "BACKEND_OPEN_FAILED",
                        message: `backend.json designates pglite as authoritative, but opening the pglite store failed: ${err?.message ?? String(err)}`,
                        exitCode: 4,
                    });
                }
                await probe.close?.().catch(() => undefined);
                return fail({
                    code: "BACKEND_MISMATCH",
                    message: "backend.json designates pglite as authoritative, but this workflow uses the synchronous createSmithers() bun:sqlite backend, which cannot serve pglite. " +
                        "Re-author it with the async factory:\n\n" +
                        "  const { smithers, Workflow, outputs } = await openSmithersBackend(schemas);\n\n" +
                        "or run on the leftover SQLite store with SMITHERS_BACKEND=sqlite (or --backend sqlite).",
                    exitCode: 4,
                });
            }
        }
        ensureSmithersTables(workflow.db);
        if (options.hot) {
            process.stderr.write(`[hot] Hot reload enabled\n`);
        }
        setupSqliteCleanup(workflow);
        const adapter = new SmithersDb(workflow.db);
        // Recover rewinds interrupted by a prior crash before driving the run.
        // jumpToFrame writes a durable in_progress audit marker before mutating,
        // but nothing acted on it at startup, so a process kill mid-rewind left
        // runs silently un-recovered. (SQLite-only; non-fatal.)
        {
            const { recoverRewindAuditsAtStartup } = await import("@smithers-orchestrator/time-travel/recoverRewindAuditsAtStartup");
            await recoverRewindAuditsAtStartup(adapter, {
                onRecovered: (count) => process.stderr.write(`⚠ Recovered ${count} incomplete rewind(s) from a prior crash; affected run(s) flagged needs-attention.\n`),
                onError: (error) => process.stderr.write(`⚠ Rewind-audit recovery failed: ${error instanceof Error ? error.message : String(error)}\n`),
            });
        }
        if (!resume) {
            const staleRuns = await adapter.listRuns(10, "running");
            if (staleRuns.length > 0) {
                // Print commands that run as written: bare `smithers cancel`
                // and `smithers up --resume` both fail validation, so
                // substitute each run's real id and workflow path. (#27)
                process.stderr.write(`⚠ Found ${staleRuns.length} run(s) still marked as 'running':\n`);
                for (const r of staleRuns) {
                    process.stderr.write(`  ${r.runId} (started ${new Date(r.startedAtMs ?? r.createdAtMs).toISOString()})\n`);
                    process.stderr.write(`    cancel it:  smithers cancel ${r.runId}\n`);
                    process.stderr.write(`    resume it:  smithers up ${r.workflowPath ?? "<workflow-file>"} --resume --run-id ${r.runId}\n`);
                }
            }
        }
        let existingRun = null;
        if (runId) {
            existingRun = await adapter.getRun(runId);
            if (resume && !existingRun) {
                return fail({ code: "RUN_NOT_FOUND", message: `Run not found: ${runId}`, exitCode: 4 });
            }
            if (resume && existingRun?.status === "running" && isRunHeartbeatFresh(existingRun) && !options.force) {
                return fail({ code: "RUN_STILL_RUNNING", message: `Run is still actively running: ${runId}. Use --force to resume anyway.`, exitCode: 4 });
            }
            if (!resume && existingRun) {
                return fail({ code: "RUN_EXISTS", message: `Run already exists: ${runId}`, exitCode: 4 });
            }
        }
        // A declared parent must exist in the same store this run records
        // into, or every lineage surface (inspect/ps/MCP) would show a
        // dangling link. Checked against the workflow's own adapter so the
        // detached child re-validates even if the workspace store moved
        // between the parent process's check and this launch.
        if (options.parentRunId) {
            const parentRun = await adapter.getRun(options.parentRunId);
            if (!parentRun) {
                return fail({
                    code: "PARENT_RUN_NOT_FOUND",
                    message: `Parent run not found: ${options.parentRunId}`,
                    exitCode: 4,
                });
            }
        }
        // Resolve the task root consistently across every launch form (#283).
        // An explicit --root always wins. Resuming without --root re-uses the
        // absolute root persisted on the original run, so detached/supervised
        // resumes can't drift to the workflow directory. Otherwise anchor to the
        // project root — the same anchor `createSmithers()` uses for the DB.
        const persistedRootDir = resume ? parsePersistedRootDir(existingRun?.configJson) : undefined;
        const rootDir = !options.root && persistedRootDir
            ? persistedRootDir
            : resolveLaunchRootDir(options.root);
        const logDir = options.log ? options.logDir : null;
        const onProgress = buildProgressReporter();
        const abort = setupAbortSignal();
        const resumeClaim = options.resumeClaimOwner && options.resumeClaimHeartbeat
            ? {
                claimOwnerId: options.resumeClaimOwner,
                claimHeartbeatAtMs: options.resumeClaimHeartbeat,
                restoreRuntimeOwnerId: options.resumeRestoreOwner ?? null,
                restoreHeartbeatAtMs: options.resumeRestoreHeartbeat ?? null,
            }
            : undefined;
        // Shared run-completion response for both the plain and --serve paths:
        // set the exit code, launch the post-failure autopsy on failure, narrate
        // the run for a human (a cheap agent writes + opens an HTML summary), and
        // attach the next-steps CTA (concise for humans, agent script otherwise).
        const finishRun = async (result) => {
            process.exitCode = formatStatusExitCode(result.status);
            if (result.status === "failed") {
                launchPostFailureAutopsy({
                    failedRunId: result.runId,
                    workflowPath: resolvedWorkflowPath,
                    enabled: options.postFailure !== false,
                });
            }
            const reportEnabled = humanTty && options.report !== false && process.env.SMITHERS_NO_REPORT !== "1";
            if (reportEnabled && result.runId) {
                const report = await generateRunReport({
                    adapter,
                    runId: result.runId,
                    workflowName: workflowIdFromPath(workflowPath),
                    result,
                    cwd: rootDir,
                    packDir: resolve(process.cwd(), ".smithers"),
                    open: openInBrowser,
                });
                if (report) {
                    const relReport = relative(process.cwd(), report.reportPath) || report.reportPath;
                    process.stderr.write(`\n${pc.cyan("summary")}\n${report.terminal}\n`);
                    process.stderr.write(`${pc.dim(report.opened ? `↗ opened ${relReport}` : `report written to ${relReport}`)}\n`);
                }
            }
            const outputResult = c.format === "json" || c.format === "jsonl"
                ? result
                : summarizeRunResult(result);
            return c.ok(outputResult, {
                cta: result.runId ? withAgentNextSteps({
                    workflowId: workflowIdFromPath(workflowPath),
                    workflowFile: workflowPath,
                    runId: result.runId,
                    human: humanTty,
                }, [
                    ...pauseCtas(result.status, result.runId),
                    ...getWorkflowFollowUpCtas(workflowPath),
                    { command: `inspect ${result.runId}`, description: "Inspect run state" },
                    { command: `logs ${result.runId}`, description: "View run logs" },
                    { command: `chat ${result.runId}`, description: "View agent chat" },
                ], isWaitingStatus(result.status)
                    ? "Run is paused (exit 3 = awaiting a decision, not a failure). Next steps:"
                    : "Next steps:") : undefined,
            });
        };
        if (options.serve) {
            let hostedSupervisor = null;
            if (options.supervise) {
                try {
                    hostedSupervisor = resolveSupervisorOptions(options.superviseInterval, options.superviseStaleThreshold, options.superviseMaxConcurrent, options.superviseDryRun);
                }
                catch (error) {
                    return fail({
                        code: error instanceof SmithersError
                            ? error.code
                            : "INVALID_SUPERVISOR_OPTIONS",
                        message: error?.message ?? String(error),
                        exitCode: 4,
                    });
                }
            }
            // The serve app exposes mutating run-control endpoints
            // (POST /approve, /deny, /cancel) and only enforces auth when a
            // token is set. Mirror the gateway guard: refuse a non-loopback
            // bind without a token unless --insecure is passed.
            const serveAuthToken = options.authToken ?? process.env.SMITHERS_API_KEY;
            if (!GATEWAY_LOOPBACK_HOSTS.has(options.host) && !serveAuthToken && !options.insecure) {
                return fail({
                    code: "SERVE_INSECURE_BIND",
                    message: `Refusing to bind the run-control HTTP server to non-loopback host "${options.host}" without authentication. This would expose unauthenticated approve/deny/cancel control of the run to the network. Set --auth-token <token> (or SMITHERS_API_KEY), bind to 127.0.0.1, or pass --insecure to override.`,
                    exitCode: 4,
                });
            }
            const { createServeApp } = await import("@smithers-orchestrator/server/serve");
            const effectiveRunId = runId ?? `run-${Date.now()}`;
            const serveApp = createServeApp({
                workflow: workflow,
                adapter: adapter,
                runId: effectiveRunId,
                abort,
                authToken: serveAuthToken,
                // Forward --insecure so a deliberate unauthenticated non-loopback
                // bind actually trusts the LAN Host, instead of passing the bind
                // guard but then 403-ing every request as a non-loopback Host.
                insecure: options.insecure,
                metrics: options.metrics,
            });
            const bunServer = Bun.serve({
                port: options.port,
                hostname: options.host,
                fetch: serveApp.fetch,
            });
            process.stderr.write(`[smithers] HTTP server listening on http://${formatHttpHost(options.host)}:${bunServer.port}\n`);
            const supervisorFiber = hostedSupervisor
                ? runFork(supervisorLoopEffect({
                    adapter,
                    dryRun: hostedSupervisor.dryRun,
                    pollIntervalMs: hostedSupervisor.pollIntervalMs,
                    staleThresholdMs: hostedSupervisor.staleThresholdMs,
                    maxConcurrent: hostedSupervisor.maxConcurrent,
                }))
                : null;
            if (hostedSupervisor) {
                process.stderr.write(`[smithers] Supervisor enabled (interval=${hostedSupervisor.pollIntervalMs}ms, staleThreshold=${hostedSupervisor.staleThresholdMs}ms, maxConcurrent=${hostedSupervisor.maxConcurrent}, dryRun=${hostedSupervisor.dryRun})\n`);
            }
            const workflowPromise = Effect.runPromise(runWorkflow(workflow, {
                input,
                runId: effectiveRunId,
                parentRunId: options.parentRunId,
                ...(detachedLogFile ? { config: { logFile: detachedLogFile } } : {}),
                ...buildDurabilityRunOptions({ resume, force: options.force, acceptWorkflowChange: options.acceptWorkflowChange }),
                resumeClaim,
                workflowPath: resolvedWorkflowPath,
                maxConcurrency: options.maxConcurrency,
                rootDir,
                logDir,
                allowNetwork: options.allowNetwork,
                maxOutputBytes: options.maxOutputBytes,
                toolTimeoutMs: options.toolTimeoutMs,
                hot: options.hot,
                annotations,
                onProgress,
                signal: abort.signal,
            }));
            workflowPromise.then((result) => {
                process.stderr.write(`[smithers] Workflow ${result.status}. Server still running — press Ctrl+C to stop.\n`);
            }).catch((err) => {
                process.stderr.write(`[smithers] Workflow error: ${err?.message ?? String(err)}. Server still running.\n`);
            });
            const result = await new Promise((resolvePromise) => {
                const shutdown = async () => {
                    abort.abort();
                    bunServer.stop(true);
                    if (supervisorFiber) {
                        await runPromise(Fiber.interrupt(supervisorFiber)).catch(() => undefined);
                    }
                    try {
                        const r = await workflowPromise;
                        resolvePromise(r);
                    }
                    catch {
                        resolvePromise({ runId: effectiveRunId, status: "cancelled" });
                    }
                };
                process.once("SIGINT", () => shutdown());
                process.once("SIGTERM", () => shutdown());
            });
            return await finishRun(result);
        }
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input,
            runId,
            parentRunId: options.parentRunId,
            ...(detachedLogFile ? { config: { logFile: detachedLogFile } } : {}),
            ...buildDurabilityRunOptions({ resume, force: options.force, acceptWorkflowChange: options.acceptWorkflowChange }),
            resumeClaim,
            workflowPath: resolvedWorkflowPath,
            maxConcurrency: options.maxConcurrency,
            rootDir,
            logDir,
            allowNetwork: options.allowNetwork,
            maxOutputBytes: options.maxOutputBytes,
            toolTimeoutMs: options.toolTimeoutMs,
            hot: options.hot,
            annotations,
            onProgress,
            signal: abort.signal,
        }));
        return await finishRun(result);
    }
    catch (err) {
        return fail({ code: "RUN_FAILED", message: err?.message ?? String(err), exitCode: 1 });
    }
}
/**
 * @param {string} id
 * @returns {string}
 */
function titleizeWorkflowId(id) {
    return id
        .replace(/[-_:]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
}
/**
 * Resolve the workspace root a gateway (or gateway client) should serve:
 * the nearest local .smithers pack's parent, else the directory holding the
 * nearest smithers.db. Returns undefined when neither exists.
 *
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
function resolveGatewayWorkspace(cwd = cliWorkspace.cwd()) {
    const localPackDir = resolvePackDirs(cwd).find((dir) => dir.scope === "local")?.packDir;
    if (localPackDir)
        return dirname(localPackDir);
    try {
        return dirname(findSmithersDb(cwd));
    }
    catch {
        return undefined;
    }
}

function formatHttpHost(host) {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function formatGatewayAutostartDiagnostics(workspace, failure) {
    const { logFile } = gatewayRuntimePaths(workspace);
    // Last 20 log lines: enough stderr context to diagnose a failed spawn
    // without dumping the whole daemon log into the error message.
    let tail = null;
    try {
        const text = readFileSync(logFile, "utf8").trimEnd();
        if (text)
            tail = text.split(/\r?\n/).slice(-20).join("\n");
    }
    catch {
        // Missing/unreadable log file: report the headline without a tail.
    }
    const headline = failure?.kind === "error"
        ? `Autostarted gateway failed to spawn: ${failure.error?.message ?? String(failure.error)}.`
        : failure?.kind === "exit"
            ? `Autostarted gateway exited before it became reachable (exit code ${failure.code ?? "null"}${failure.signal ? `, signal ${failure.signal}` : ""}).`
            : "Autostarted gateway did not become reachable before the wait timed out.";
    return `${headline}\nGateway autostart log: ${logFile}${tail ? `\nLast gateway stderr:\n${tail}` : "\nNo gateway stderr has been written yet."}`;
}

function warnIfBrowserUiNeedsBearer(token) {
    if (!token)
        return;
    process.stderr.write("[smithers] Warning: this Gateway requires a bearer token. CLI RPC calls use the state-file/env token, but browser navigations cannot send that header yet, so the workflow UI URL may return 401. Start `smithers gateway` without --mint-token for browser UI access until UI token injection ships.\n");
}

/**
 * Ensure the workspace's singleton gateway is running and return how to
 * reach it. Discovery first (runtime state file, verified against pid and
 * /health workspace identity); otherwise claim the per-workspace autostart
 * lock, spawn a detached `smithers gateway`, and wait for its state file.
 * A racing client that loses the lock just waits for the winner's daemon.
 *
 * @param {string} workspace
 * @param {number} preferredPort
 * @returns {Promise<{ base: string; token: string | null; started: boolean } | { failed: true; message: string } | null>}
 */
async function ensureWorkspaceGateway(workspace, preferredPort) {
    const discovered = await discoverWorkspaceGateway(workspace);
    if (discovered) {
        return { base: discovered.state.url, token: discovered.state.token, started: false };
    }
    const lock = claimGatewayAutostartLock(workspace);
    if (!lock) {
        const awaited = await waitForWorkspaceGateway(workspace);
        return awaited ? { base: awaited.state.url, token: awaited.state.token, started: false } : null;
    }
    let child;
    let stderrFd;
    try {
        const { logFile } = gatewayRuntimePaths(workspace);
        stderrFd = openSync(logFile, "w", 0o600);
        // Autostarted daemons idle-exit (spec decision 14) so they never outlive
        // the client that started them. Default 5 min idle; SMITHERS_GATEWAY_IDLE_MS
        // overrides (0 disables). An explicit `smithers gateway` gets no flag and stays up.
        const autostartIdleMs = process.env.SMITHERS_GATEWAY_IDLE_MS
            ? String(Math.max(0, Math.floor(Number(process.env.SMITHERS_GATEWAY_IDLE_MS) || 0)))
            : "300000";
        child = spawn(process.argv[0], [process.argv[1], "gateway", "--host", "127.0.0.1", "--port", String(preferredPort), "--idle-timeout", autostartIdleMs], {
            stdio: ["ignore", stderrFd, stderrFd],
            detached: true,
            cwd: workspace,
        });
        child.unref();
    }
    catch (error) {
        if (stderrFd !== undefined) {
            try {
                closeSync(stderrFd);
            }
            catch { }
        }
        lock.release();
        return { failed: true, message: formatGatewayAutostartDiagnostics(workspace, { kind: "error", error }) };
    }
    if (stderrFd !== undefined) {
        try {
            closeSync(stderrFd);
        }
        catch { }
    }
    try {
        // Gateway boot loads + compiles every workspace workflow before it
        // listens, so allow generous time for the state file to appear.
        const childFailure = new Promise((resolvePromise) => {
            child.once("error", (error) => resolvePromise({ kind: "error", error }));
            child.once("exit", (code, signal) => resolvePromise({ kind: "exit", code, signal }));
        });
        const result = await Promise.race([
            waitForWorkspaceGateway(workspace).then((awaited) => ({ kind: "ready", awaited })),
            childFailure.then((failure) => ({ kind: "failed", failure })),
        ]);
        if (result.kind === "failed") {
            return { failed: true, message: formatGatewayAutostartDiagnostics(workspace, result.failure) };
        }
        return result.awaited ? { base: result.awaited.state.url, token: result.awaited.state.token, started: true } : null;
    }
    finally {
        lock.release();
    }
}
/**
 * Resolve a reachable Gateway for a browser-facing command (`smithers ui`,
 * `smithers monitor`): explicit --gateway probe → workspace runtime-state
 * discovery → legacy port probe (refused on workspace-identity mismatch) →
 * autostart, unless the daemon escape hatch disables it.
 *
 * @param {{ gateway?: string; port: number; autostart?: boolean; daemon?: boolean }} options
 * @returns {Promise<{ ok: true; base: string; token: string | null; workspace: string | undefined } | { ok: false; message: string }>}
 */
async function resolveBrowserGateway(options) {
    const workspace = options.gateway ? undefined : resolveGatewayWorkspace();
    let base = options.gateway ? options.gateway.replace(/\/+$/, "") : null;
    let token = base ? resolveGatewayBearer(workspace, base) : null;
    let reachable = false;
    let autostartAttempted = false;
    let autostartFailureMessage = null;
    if (base) {
        // Explicitly pinned gateway: the user chose it, probe it as-is.
        reachable = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    }
    else if (workspace) {
        // The workspace's singleton, via the runtime state file (verified
        // against the pid and the /health workspace identity).
        const discovered = await discoverWorkspaceGateway(workspace);
        if (discovered) {
            base = discovered.state.url;
            token = resolveGatewayBearer(workspace, base);
            reachable = true;
        }
    }
    if (!reachable && !base) {
        // Legacy probe: a gateway started by an older CLI or the SDK on the
        // conventional port, with no runtime state file. An explicit identity
        // mismatch is refused; identity-less legacy gateways are trusted.
        const legacyBase = `http://127.0.0.1:${options.port}`;
        const health = await fetch(`${legacyBase}/health`).then((r) => (r.ok ? r.json() : null), () => null);
        if (health) {
            const advertised = health?.identity?.workspaceRoot;
            if (!advertised || !workspace || canonicalWorkspacePath(advertised) === canonicalWorkspacePath(workspace)) {
                base = legacyBase;
                token = resolveGatewayBearer(workspace, base);
                reachable = true;
            }
            else {
                process.stderr.write(`[smithers] Ignoring the gateway at ${legacyBase}: it serves ${advertised}, not ${workspace}.\n`);
            }
        }
    }
    // Daemon escape hatch (spec decision 18): --no-daemon / SMITHERS_NO_DAEMON
    // suppresses autostart. For ui/gui/monitor the gateway is genuinely
    // required (it serves the UI), so a disabled daemon with none already
    // running fails loudly below rather than silently spawning one.
    const daemonDisabled = isDaemonDisabled(options);
    if (!reachable && options.autostart && workspace && !daemonDisabled) {
        process.stderr.write(`[smithers] No gateway for ${workspace}; starting one (smithers gateway)…\n`);
        autostartAttempted = true;
        const ensured = await ensureWorkspaceGateway(workspace, options.port);
        if (ensured?.failed) {
            autostartFailureMessage = ensured.message;
        }
        else if (ensured) {
            base = ensured.base;
            token = ensured.token ?? resolveGatewayBearer(workspace, base);
            reachable = true;
        }
    }
    if (!reachable) {
        const detail = daemonDisabled
            ? "\n\nGateway autostart is disabled (--no-daemon or SMITHERS_NO_DAEMON=1). Start one explicitly with `smithers gateway`, or unset the escape hatch."
            : autostartAttempted && workspace
                ? `\n\n${autostartFailureMessage ?? formatGatewayAutostartDiagnostics(workspace)}`
                : "";
        return { ok: false, message: `No Smithers Gateway reachable${base ? ` at ${base}` : " for this workspace"}. Start one with \`smithers gateway\` (it serves workflow-owned UIs declared with <UI>), or pass --gateway <url> to point at a running one. Note: \`smithers up --serve\` is a per-run server, not a full Gateway.${detail}` };
    }
    return { ok: true, base, token, workspace };
}
/** Path the CLI-booted gateway mounts the Smithers Monitor UI on. */
const MONITOR_UI_MOUNT_PATH = "/monitor";
/**
 * `smithers monitor` — open the Smithers Monitor, a live web UI over every
 * run in this workspace (runs list, execution tree, events, approvals). It
 * observes; it never launches a run. The page itself is served by the
 * workspace gateway at /monitor (see runGatewayCommand's monitor UI mount).
 */
async function runMonitorCommand(c) {
    const fail = (code, message) => c.error({ code, message, exitCode: 1 });
    const resolved = await resolveBrowserGateway(c.options);
    if (!resolved.ok) {
        return fail("GATEWAY_UNREACHABLE", resolved.message);
    }
    const { base, token } = resolved;
    const runId = c.args.runId;
    const url = `${base}${MONITOR_UI_MOUNT_PATH}${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`;
    warnIfBrowserUiNeedsBearer(token);
    const opened = c.options.open ? openInBrowser(url) : false;
    console.log(`${opened ? "Opening" : "Monitor URL:"} ${url}`);
    return c.ok({ opened, url, gateway: base, runId: runId ?? null }, {
        cta: {
            description: "The monitor shows every run this gateway owns, live.",
            commands: [
                { command: "ps", description: "List runs in the terminal instead" },
                { command: "ui <runId>", description: "Open a run's own workflow UI" },
            ],
        },
    });
}
/**
 * Resolve a run's workflow without trusting a gateway's adapter-owner fallback.
 * Older gateways can report the first registered shared-DB workflow as
 * `workflowKey`; accept that value only when persisted run provenance supports
 * it. A gateway key written into config by `Gateway.startRun` remains
 * authoritative.
 * @param {Record<string, unknown> | null | undefined} run
 * @returns {string | undefined}
 */
function workflowKeyForUiRun(run) {
    if (!run || typeof run !== "object") {
        return undefined;
    }
    let configuredKey;
    try {
        const config = typeof run.configJson === "string"
            ? JSON.parse(run.configJson)
            : run.configJson;
        configuredKey = typeof config?.gatewayWorkflowKey === "string" && config.gatewayWorkflowKey
            ? config.gatewayWorkflowKey
            : undefined;
    }
    catch { }
    if (configuredKey) {
        return configuredKey;
    }
    const advertisedKey = typeof run.workflowKey === "string" && run.workflowKey
        ? run.workflowKey
        : undefined;
    const workflowName = typeof run.workflowName === "string" && run.workflowName
        ? run.workflowName
        : undefined;
    const pathKey = typeof run.workflowPath === "string" && run.workflowPath
        ? workflowIdFromPath(run.workflowPath)
        : undefined;
    if (advertisedKey && (advertisedKey === workflowName || advertisedKey === pathKey)) {
        return advertisedKey;
    }
    return pathKey ?? workflowName ?? advertisedKey;
}
async function runUiCommand(c) {
    const fail = (code, message) => c.error({ code, message, exitCode: 1 });
    const resolved = await resolveBrowserGateway(c.options);
    if (!resolved.ok) {
        return fail("GATEWAY_UNREACHABLE", resolved.message);
    }
    const { base, token } = resolved;
    // `--app`: serve the FULL local Smithers UI (apps/smithers) instead of a
    // single workflow-run UI. Build the bundle if needed, then serve it from a
    // static server that reverse-proxies the gateway so the app is same-origin.
    if (c.options.app) {
        warnIfBrowserUiNeedsBearer(token);
        return runFullUiCommand(c, base, fail);
    }
    const rpc = async (method, params = {}) => {
        const res = await fetch(`${base}/v1/rpc/${method}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(params),
        });
        const frame = await res.json().catch(() => null);
        if (!frame || frame.type !== "res") {
            const command = c.options.gateway
                ? "smithers gateway"
                : `smithers gateway --port ${c.options.port}`;
            throw new Error(`Gateway at ${base} returned an invalid RPC frame for ${method}. Make sure this URL points at \`${command}\`, not \`smithers up --serve\` or an older per-run server.`);
        }
        if (!frame.ok) {
            throw new Error(frame.error?.message ?? `Gateway RPC ${method} failed.`);
        }
        return frame.payload;
    };
    try {
        const listWorkflowMap = async () => {
            const workflows = await rpc("listWorkflows", {});
            return new Map((Array.isArray(workflows) ? workflows : []).map((workflow) => [workflow.key, workflow]));
        };
        let byKey = await listWorkflowMap();
        let workflowKey = c.options.workflow;
        let runId = c.args.runId;
        if (!workflowKey) {
            if (!runId) {
                const runs = await rpc("listRuns", {});
                const latest = Array.isArray(runs) ? runs[0] : undefined;
                if (!latest) {
                    return fail("NO_RUNS", "No runs found in this workspace yet, so there is no run UI to open. Start one with `smithers up <workflow.tsx>` or `smithers workflow run <id>` and re-run this command, pass --workflow <id> to open a workflow's UI directly, or run `smithers ui --app` for the full control-plane UI.");
                }
                runId = latest.runId ? String(latest.runId) : undefined;
                workflowKey = workflowKeyForUiRun(latest);
            }
            if (!workflowKey && runId) {
                const run = await rpc("getRun", { runId });
                workflowKey = workflowKeyForUiRun(run);
            }
        }
        if (!workflowKey) {
            return fail("WORKFLOW_UNRESOLVED", runId ? `Could not resolve a workflow for run ${runId}.` : "Could not resolve a workflow to open.");
        }
        let summary = byKey.get(workflowKey);
        if (!summary) {
            // A long-lived gateway may predate this workflow. Probe only the
            // exact conventional route: current gateways use that lookup miss
            // to rescan the workspace registry. Then read the authoritative
            // mount path again, since a workflow can declare a custom path.
            await fetch(`${base}/workflows/${encodeURIComponent(workflowKey)}`, {
                method: "HEAD",
                headers: token ? { authorization: `Bearer ${token}` } : {},
            }).catch(() => null);
            byKey = await listWorkflowMap();
            summary = byKey.get(workflowKey);
        }
        if (!summary || !summary.hasUi || !summary.uiPath) {
            const runDetail = runId ? ` for run ${runId}` : "";
            return fail("NO_UI", `Workflow "${workflowKey}"${runDetail} is not served with a UI by the Gateway at ${base}. Check the gateway warning log for a workflow load error, or add a .smithers/ui/${workflowKey}.tsx file (or <UI> declaration) and retry.`);
        }
        const url = `${base}${summary.uiPath}${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`;
        warnIfBrowserUiNeedsBearer(token);
        if (c.options.open) openInBrowser(url);
        console.log(`${c.options.open ? "Opening" : "UI URL:"} ${url}`);
        return c.ok({ opened: c.options.open, url, runId: runId ?? null, workflow: workflowKey }, {
            cta: buildAgentNextSteps({
                workflowId: workflowKey,
                runId: runId ?? undefined,
                hasUi: true,
                uiOpened: true,
            }),
        });
    }
    catch (err) {
        return fail("UI_OPEN_FAILED", err?.message ?? String(err));
    }
}
/**
 * Serve the full local Smithers UI (apps/smithers) against a running Gateway.
 * Builds the bundle on first use, then keeps a static+proxy server alive so the
 * single-page app runs same-origin with the gateway (its WebSocket needs it).
 */
async function runFullUiCommand(c, base, fail) {
    const { serveLocalUi } = await import("./localUiServer.js");
    try {
        const { server, url } = await serveLocalUi({
            gatewayBase: base,
            port: c.options.appPort,
            rebuild: c.options.rebuild,
        });
        if (c.options.open) openInBrowser(url);
        console.log(`${c.options.open ? "Opening" : "UI URL:"} ${url}`);
        console.log(`[smithers] Serving the full Smithers UI (gateway: ${base}). Press Ctrl-C to stop.`);
        const stop = () => {
            server.close();
            process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        await new Promise(() => { });
        return c.ok({ opened: c.options.open, url, gateway: base });
    }
    catch (err) {
        return fail("UI_SERVE_FAILED", err?.message ?? String(err));
    }
}
const GATEWAY_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

function gatewayAlreadyRunningError(workspace, state) {
    return new SmithersError("GATEWAY_ALREADY_RUNNING", `A gateway for this workspace is already running: pid ${state.pid} at ${state.url}. Use it, or stop it first with \`smithers gateway stop\`.`, { workspace, pid: state.pid, url: state.url });
}

async function closeGatewayStartupResources(gateway, backendCleanups) {
    try {
        await gateway?.close?.();
    }
    catch {
        // Best effort: the command is already aborting startup.
    }
    for (const cleanup of backendCleanups.reverse()) {
        try {
            await cleanup?.();
        }
        catch {
            // Best effort: the command is already aborting startup.
        }
    }
}

async function runGatewayStatusCommand(c) {
    const workspace = resolveGatewayWorkspace();
    if (!workspace) {
        return c.error({ code: "CLI_DB_NOT_FOUND", message: "No workspace found: no .smithers/ pack or smithers.db in this directory or any parent. Run `smithers init` first.", exitCode: 1 });
    }
    const { stateFile } = gatewayRuntimePaths(workspace);
    const discovered = await discoverWorkspaceGateway(workspace);
    if (!discovered) {
        return c.ok({ running: false, workspace, stateFile }, {
            cta: { commands: [{ command: "gateway", description: "Start the workspace gateway" }] },
        });
    }
    const { state, identity } = discovered;
    return c.ok({
        running: true,
        workspace,
        url: state.url,
        pid: state.pid,
        port: state.port,
        backend: identity.backend ?? state.backend ?? null,
        version: identity.version ?? state.version ?? null,
        auth: state.token ? "token" : "none",
        startedAtMs: state.startedAtMs,
        stateFile,
    });
}
async function runGatewayStopCommand(c) {
    const workspace = resolveGatewayWorkspace();
    if (!workspace) {
        return c.error({ code: "CLI_DB_NOT_FOUND", message: "No workspace found: no .smithers/ pack or smithers.db in this directory or any parent.", exitCode: 1 });
    }
    let state;
    try {
        assertGatewayRuntimeStateFileTrusted(workspace);
        state = readGatewayRuntimeState(workspace);
    }
    catch (error) {
        if (error?.code === "GATEWAY_STATE_UNTRUSTED") {
            return c.error({ code: "GATEWAY_STATE_UNTRUSTED", message: error?.message ?? String(error), exitCode: 1 });
        }
        throw error;
    }
    if (!state) {
        return c.ok({ stopped: false, running: false, workspace });
    }
    // Verify pid AND identity before signalling: a recycled pid, or a state
    // file describing a dead daemon, must never get a SIGTERM aimed at it.
    const health = await probeGatewayHealthIdentity(state.url, workspace);
    if (!health.ok) {
        if (health.reason === "transient") {
            return c.error({ code: "GATEWAY_STOP_UNREACHABLE", message: `Gateway pid ${state.pid} did not answer /health in time. Leaving the runtime state file intact and refusing to signal an unverified process.`, exitCode: 1 });
        }
        clearGatewayRuntimeState(workspace, state.pid);
        return c.ok({ stopped: false, running: false, workspace, cleanedStaleState: true });
    }
    const identity = health.identity;
    if (identity.pid !== state.pid) {
        clearGatewayRuntimeState(workspace, state.pid);
        return c.ok({ stopped: false, running: false, workspace, cleanedStaleState: true });
    }
    try {
        process.kill(state.pid, "SIGTERM");
    }
    catch (error) {
        return c.error({ code: "GATEWAY_STOP_FAILED", message: `Could not signal gateway pid ${state.pid}: ${error?.message ?? String(error)}`, exitCode: 1 });
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (!(await verifyGatewayHealthIdentity(state.url, workspace)))
            break;
        await new Promise((r) => setTimeout(r, 200));
    }
    if (await verifyGatewayHealthIdentity(state.url, workspace)) {
        return c.error({ code: "GATEWAY_STOP_TIMEOUT", message: `Gateway pid ${state.pid} did not shut down within 10s. Inspect it (or kill -9 ${state.pid}) manually.`, exitCode: 1 });
    }
    clearGatewayRuntimeState(workspace, state.pid);
    return c.ok({ stopped: true, workspace, pid: state.pid });
}
/**
 * @param {{ host: string; port: number; backend?: "sqlite" | "pglite" | "postgres"; authToken?: string; mintToken?: boolean; insecure?: boolean; idleTimeout?: number }} options
 * @returns {Promise<{ url: string; workspace: string; dbPath: string; workflows: string[] }>}
 */
async function runGatewayCommand(options) {
    // The Gateway control plane can launch/cancel/inspect EVERY run in the
    // workspace. Without an auth config it authenticates every request as
    // role=operator scopes=["*"]. Refuse to publish that to the network: a
    // non-loopback bind requires a token (or an explicit --insecure override).
    const explicitToken = options.authToken ?? (process.env.SMITHERS_API_KEY || undefined);
    const authToken = explicitToken ?? (options.mintToken ? mintGatewayToken() : undefined);
    const isLoopback = GATEWAY_LOOPBACK_HOSTS.has(options.host);
    if (!isLoopback && !authToken && !options.insecure) {
        throw new SmithersError("GATEWAY_INSECURE_BIND", `Refusing to bind the Gateway to non-loopback host "${options.host}" without authentication — this would expose a full-control, unauthenticated control plane to the network. Set --auth-token <token> (or SMITHERS_API_KEY), bind to 127.0.0.1, or pass --insecure to override.`, { host: options.host });
    }
    // A durable operator token (--auth-token / SMITHERS_API_KEY) is a long-lived,
    // possibly org-wide secret: never copy it to the on-disk state file. When one
    // is supplied, mint a SEPARATE session-only bearer, record only that in the
    // 0600 state file (so cross-shell clients — ui/status/delegated RPC — can
    // still discover a working bearer), and register BOTH so the operator's own
    // token keeps authenticating. A purely minted token (--mint-token) is already
    // ephemeral, so it stays the state-file token.
    const sessionToken = explicitToken ? mintGatewayToken() : undefined;
    const stateToken = sessionToken ?? authToken ?? null;
    const auth = authToken
        ? {
            mode: "token",
            tokens: {
                [authToken]: { role: "operator", scopes: ["*"] },
                ...(sessionToken ? { [sessionToken]: { role: "operator", scopes: ["*"] } } : {}),
            },
        }
        : undefined;
    const operatorCwd = cliWorkspace.cwd();
    const manifestFallback = cliWorkspace.usesManifestFallback();
    const localPackDir = resolvePackDirs(operatorCwd).find((dir) => dir.scope === "local")?.packDir;
    const localWorkspace = localPackDir ? dirname(localPackDir) : undefined;
    /** @type {string} */
    let dbPath;
    if (localWorkspace) {
        dbPath = resolve(localWorkspace, "smithers.db");
    }
    else {
        try {
            dbPath = findSmithersDb(operatorCwd);
        }
        catch (error) {
            if (!(error instanceof SmithersError) || error.code !== "CLI_DB_NOT_FOUND") {
                throw error;
            }
            // No local pack AND no existing DB anywhere up the tree. That is
            // still a servable workspace — a bare repo backed by the global
            // ~/.smithers pack (the sandbox-VM shape: clone a repo with no
            // .smithers, serve the `smithers init --global` catalog). Create
            // the DB at the operator cwd, exactly where a local-pack boot
            // would put it, instead of refusing to start.
            dbPath = resolve(operatorCwd, "smithers.db");
        }
    }
    const workspace = localWorkspace ?? dirname(dbPath);
    const startLock = claimGatewayDaemonStartLock(workspace);
    if (!startLock) {
        const winner = await waitForWorkspaceGateway(workspace);
        if (winner) {
            throw gatewayAlreadyRunningError(workspace, winner.state);
        }
        throw new SmithersError("GATEWAY_START_IN_PROGRESS", `Another gateway start is already in progress for ${workspace}, but no healthy gateway became discoverable before the wait timed out.`, { workspace });
    }
    let startLockReleased = false;
    const releaseStartLock = () => {
        if (startLockReleased)
            return;
        startLock.release();
        startLockReleased = true;
    };
    /** @type {import("@smithers-orchestrator/server/gateway").Gateway | undefined} */
    let gateway;
    /** @type {Array<() => unknown | Promise<unknown>>} */
    const backendCleanups = [];
    /** @type {string[]} */
    const workflows = [];
    let runtimeStateFile;
    let identityBackend;
    let server;
    let port;
    let url;
    let idleTimeoutMs = 0;
    try {
        // Singleton: one gateway owns a workspace. A healthy incumbent
        // (verified by pid + /health workspace identity, not just "something
        // owns the port") means this start is a mistake — point at it instead.
        const incumbent = await discoverWorkspaceGateway(workspace);
        if (incumbent) {
            throw gatewayAlreadyRunningError(workspace, incumbent.state);
        }
        const unresolvedState = readGatewayRuntimeState(workspace);
        if (unresolvedState && isGatewayPidAlive(unresolvedState.pid)) {
            throw new SmithersError("GATEWAY_ALREADY_RUNNING", `A gateway state file for this workspace names live pid ${unresolvedState.pid} at ${unresolvedState.url}, but /health did not verify in time. Refusing to start a second gateway over the same workspace.`, { workspace, pid: unresolvedState.pid, url: unresolvedState.url });
        }
    if (!manifestFallback) {
        process.chdir(workspace);
    }
    if (options.backend) {
        process.env.SMITHERS_BACKEND = options.backend;
    }
    const [{ Gateway }, { openSmithersBackend }] = await Promise.all([
        import("@smithers-orchestrator/server/gateway"),
        import("smithers-orchestrator"),
    ]);
    identityBackend = options.backend ?? process.env.SMITHERS_BACKEND ?? readBackendMarkerForCwd(workspace) ?? "sqlite";
    // Idle spin-down (spec decision 14): autostarted daemons pass --idle-timeout
    // (see ensureWorkspaceGateway) so they exit once idle; an explicit
    // `smithers gateway` leaves it 0 and stays up. SMITHERS_GATEWAY_IDLE_MS overrides.
    idleTimeoutMs = Math.max(0, Math.floor(Number(options.idleTimeout ?? process.env.SMITHERS_GATEWAY_IDLE_MS ?? 0) || 0));
    // Every CLI-booted gateway serves the Smithers Monitor — the live all-runs
    // web UI — at /monitor (`smithers monitor` opens it). The entry ships
    // inside the CLI package and is bundled by the gateway's UI pipeline on
    // first request, so no workspace pack is required.
    const monitorUiEntry = fileURLToPath(new URL("./monitor-ui/monitor.tsx", import.meta.url));
    // PTY hijack channel (`/v1/pty/hijack`): the gateway spawns this CLI's own
    // `hijack` command inside a real PTY, so the Monitor's embedded terminal
    // gets the exact same per-node hand-off semantics as `smithers hijack
    // <runId> --target <nodeId>` in a shell — live runs hand the session off,
    // finished runs reopen the recorded agent session for a post-mortem.
    const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));
    /** @type {(params: { runId: string; nodeId?: string }) => { command: string[]; cwd?: string; env?: Record<string, string | undefined> }} */
    const hijackPty = ({ runId, nodeId }) => ({
        command: [
            process.execPath,
            cliEntry,
            "hijack",
            runId,
            ...(nodeId ? ["--target", nodeId] : []),
        ],
        cwd: workspace,
        env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
    });
    /** @type {(workflowKey: string) => Promise<void>} */
    let refreshWorkflowRegistry = async () => { };
    gateway = new Gateway({
        heartbeatMs: 15_000,
        workspaceRoot: workspace,
        workflowRegistryRefresh: (workflowKey) => refreshWorkflowRegistry(workflowKey),
        identity: { backend: identityBackend, version: readPackageVersion() },
        idleTimeoutMs,
        // The monitor's "what happened" panel: narrate a run/node with the
        // cheapest usable local agent. The route degrades to a deterministic
        // fact summary when no agent answers, so this never breaks the RPC.
        whatHappened: async ({ runId, nodeId, iteration, adapter }) => {
            const result = await whatHappened({
                adapter,
                runId,
                nodeId,
                iteration: iteration ?? undefined,
                cwd: workspace,
            });
            return { summary: result.summary, agentId: result.agentId, source: result.source };
        },
        ...(auth ? { auth } : {}),
        // `--insecure` (a deliberate unauthenticated non-loopback bind) must
        // trust any Host, or the daemon binds but 403s every LAN request.
        ...(options.insecure ? { insecure: true } : {}),
        ...(existsSync(monitorUiEntry)
            ? { ui: { entry: monitorUiEntry, path: "/monitor", title: "Smithers Monitor" } }
            : {}),
        hijackPty,
    });
    const workspaceApi = await openSmithersBackend({}, {
        backend: options.backend,
        cwd: workspace,
        dbPath,
    });
    const workspaceWorkflow = workspaceApi.smithers(() => React.createElement(workspaceApi.Workflow, { name: "workspace" }));
    ensureSmithersTables(workspaceWorkflow.db);
    setupSqliteCleanup(workspaceWorkflow);
    backendCleanups.push(() => workspaceApi.close?.());
    // Load every workflow module up front, concurrently. Each `loadWorkflow`
    // does a dynamic `import()` of the workflow's `.tsx`, and that import is the
    // single biggest chunk of gateway cold-start once a workspace has dozens of
    // packs — awaiting them one at a time serializes the transpile+evaluate of
    // ~90 modules. `Promise.all` overlaps that work (module evaluation is still
    // single-threaded, but bun's transpile and the filesystem reads pipeline),
    // shaving a few hundred ms off boot. Registration below stays a sequential
    // loop so DB writes and gateway state mutate in a stable, discovery order,
    // and a broken workflow is still skipped instead of failing the whole boot.
    const discoveredWorkflows = discoverWorkflows(workspace);
    let loadedWorkflows;
    let readOnlyWorkflow;
    if (manifestFallback) {
        // A read-only gateway must not import workspace workflow modules while
        // their nearest package.json is conflicted. Register a DB-backed shell
        // and the built-in operator UI for each discovered id instead, so
        // existing runs remain inspectable without asking Bun to resolve either
        // the workflow or its workspace-owned UI bundle. Refuse execution
        // through these shells until the merge is resolved so a launch cannot
        // silently run an empty workflow.
        readOnlyWorkflow = workspaceApi.smithers((ctx) => {
            if (!String(ctx.runId).startsWith("__smithers_ui_discovery__:")) {
                throw new SmithersError("WORKSPACE_MANIFEST_CONFLICT", "Workflow execution is disabled while package.json contains unresolved conflict markers. Resolve the manifest, then restart the gateway.");
            }
            return React.createElement(workspaceApi.Workflow, { name: "workspace" });
        });
        loadedWorkflows = discoveredWorkflows.map((discovered) => ({
            discovered,
            workflow: readOnlyWorkflow,
            loadError: null,
        }));
        for (const { discovered } of loadedWorkflows) {
            gateway.register(discovered.id, readOnlyWorkflow, {
                system: discovered.system,
                ui: true,
            });
            workflows.push(discovered.id);
        }
    }
    else {
        loadedWorkflows = await Promise.all(discoveredWorkflows.map((discovered) => loadWorkflow(discovered.entryFile).then((workflow) => ({ discovered, workflow, loadError: /** @type {unknown} */ (null) }), (loadError) => ({ discovered, workflow: /** @type {any} */ (null), loadError }))));
        for (const { discovered, workflow, loadError } of loadedWorkflows) {
            if (loadError || !workflow) {
                process.stderr.write(`[smithers] Skipping workflow ${discovered.id}: ${(/** @type {any} */ (loadError))?.message ?? String(loadError)}\n`);
                continue;
            }
            try {
                ensureSmithersTables(workflow.db);
                setupSqliteCleanup(workflow);
                backendCleanups.push(() => closeWorkflowBackend(workflow));
                gateway.register(discovered.id, workflow, { system: discovered.system, entryFile: discovered.entryFile });
                workflows.push(discovered.id);
            }
            catch (error) {
                process.stderr.write(`[smithers] Skipping workflow ${discovered.id}: ${error?.message ?? String(error)}\n`);
            }
        }
    }
    if (workflows.length === 0) {
        gateway.register("workspace", workspaceWorkflow);
        workflows.push("workspace");
    }
    // The `evals` gateway extension (issue #77): every CLI-booted gateway
    // serves it, backed by the workspace's own DB and its real discovered-
    // workflow index (so `ext.evals.saveSuite` can validate a target
    // workflowKey against what this gateway actually serves).
    const workflowIndex = new Map(loadedWorkflows
        .filter(({ loadError, workflow }) => !loadError && workflow)
        .map(({ discovered }) => [discovered.id, discovered]));
    refreshWorkflowRegistry = async (workflowKey) => {
        if (gateway.workflows.has(workflowKey)) {
            return;
        }
        const discovered = discoverWorkflows(workspace).find((candidate) => candidate.id === workflowKey);
        if (!discovered) {
            return;
        }
        if (manifestFallback) {
            if (!readOnlyWorkflow) {
                return;
            }
            try {
                gateway.register(discovered.id, readOnlyWorkflow, {
                    system: discovered.system,
                    ui: true,
                });
                workflows.push(discovered.id);
                workflowIndex.set(discovered.id, discovered);
            }
            catch (error) {
                process.stderr.write(`[smithers] Skipping workflow ${discovered.id}: ${error?.message ?? String(error)}\n`);
            }
            return;
        }
        let workflow;
        try {
            workflow = await loadWorkflow(discovered.entryFile);
        }
        catch (error) {
            process.stderr.write(`[smithers] Skipping workflow ${discovered.id}: ${error?.message ?? String(error)}\n`);
            return;
        }
        try {
            ensureSmithersTables(workflow.db);
            setupSqliteCleanup(workflow);
            gateway.register(discovered.id, workflow, {
                system: discovered.system,
                entryFile: discovered.entryFile,
            });
            backendCleanups.push(() => closeWorkflowBackend(workflow));
            workflows.push(discovered.id);
            workflowIndex.set(discovered.id, discovered);
        }
        catch (error) {
            await closeWorkflowBackend(workflow).catch(() => { });
            process.stderr.write(`[smithers] Skipping workflow ${discovered.id}: ${error?.message ?? String(error)}\n`);
        }
    };
    gateway.extend("evals", createEvalsExtension({
        adapter: new SmithersDb(workspaceWorkflow.db),
        resolveWorkflowKey: (key) => workflowIndex.get(key),
        workspace,
    }));
    try {
        server = await gateway.listen({ host: options.host, port: options.port });
    }
    catch (error) {
        if (error?.code !== "EADDRINUSE")
            throw error;
        // Something else owns the preferred port. If a healthy gateway for
        // THIS workspace raced past the singleton check, defer to it;
        // otherwise take an ephemeral port — clients discover the real port
        // from the runtime state file, not by assuming 7331.
        const raced = await discoverWorkspaceGateway(workspace);
        if (raced) {
            throw new SmithersError("GATEWAY_ALREADY_RUNNING", `A gateway for this workspace is already running: pid ${raced.state.pid} at ${raced.state.url}.`, { workspace, pid: raced.state.pid, url: raced.state.url });
        }
        process.stderr.write(`[smithers] Port ${options.port} is taken (by a different workspace or process); using an ephemeral port instead.\n`);
        server = await gateway.listen({ host: options.host, port: 0 });
    }
    const address = server.address();
    port = address && typeof address === "object" ? address.port : options.port;
    url = `http://${formatHttpHost(options.host)}:${port}`;
    const raced = await discoverWorkspaceGateway(workspace);
    if (raced) {
        throw gatewayAlreadyRunningError(workspace, raced.state);
    }
    const unresolvedStateAfterListen = readGatewayRuntimeState(workspace);
    if (unresolvedStateAfterListen && isGatewayPidAlive(unresolvedStateAfterListen.pid)) {
        throw new SmithersError("GATEWAY_ALREADY_RUNNING", `A gateway state file for this workspace names live pid ${unresolvedStateAfterListen.pid} at ${unresolvedStateAfterListen.url}, but /health did not verify in time. Refusing to overwrite it with this daemon's state.`, { workspace, pid: unresolvedStateAfterListen.pid, url: unresolvedStateAfterListen.url });
    }
    runtimeStateFile = writeGatewayRuntimeState(workspace, {
        pid: process.pid,
        host: options.host,
        port,
        url,
        token: stateToken,
        workspaceRoot: canonicalWorkspacePath(workspace),
        backend: identityBackend,
        version: readPackageVersion(),
        protocol: gateway.protocol ?? null,
        startedAtMs: Date.now(),
    });
    }
    catch (error) {
        releaseStartLock();
        await closeGatewayStartupResources(gateway, backendCleanups);
        throw error;
    }
    releaseStartLock();
    process.stderr.write(`[smithers] Gateway listening on ${url}\n`);
    process.stderr.write(`[smithers] Workspace: ${workspace}\n`);
    process.stderr.write(`[smithers] Database: ${dbPath}\n`);
    process.stderr.write(`[smithers] Registered workflows: ${workflows.join(", ")}\n`);
    process.stderr.write(`[smithers] Runtime state: ${runtimeStateFile}\n`);
    if (auth && !explicitToken && authToken) {
        process.stderr.write(`[smithers] Minted bearer token: ${authToken}\n`);
    }
    process.stderr.write(auth
        ? `[smithers] Auth: token required (Authorization: Bearer <token>)\n`
        : `[smithers] Auth: NONE — bound to loopback ${options.host}; do not expose this port\n`);
    await new Promise((resolvePromise) => {
        const shutdown = () => {
            // Backstop: if gateway/backend close hangs, force-exit after 5s so a
            // hard `kill -9` is never required. unref() so a clean close isn't held
            // open by the timer.
            const deadline = setTimeout(() => {
                process.stderr.write(`[smithers] Gateway shutdown timed out, exiting.\n`);
                process.exit(143);
            }, FORCE_EXIT_BACKSTOP_MS);
            if (typeof deadline.unref === "function")
                deadline.unref();
            try {
                clearGatewayRuntimeState(workspace, process.pid);
            }
            catch {
                // Discovery cleans a stale state file up on the next probe.
            }
            gateway.close()
                .catch((error) => {
                process.stderr.write(`[smithers] Gateway shutdown error: ${error?.message ?? String(error)}\n`);
            })
                .then(async () => {
                for (const cleanup of backendCleanups.reverse()) {
                    await cleanup?.();
                }
            })
                .catch((error) => {
                process.stderr.write(`[smithers] Backend shutdown error: ${error?.message ?? String(error)}\n`);
            })
                .finally(resolvePromise);
        };
        if (idleTimeoutMs > 0) {
            // The Gateway fires onIdle after idleTimeoutMs with no clients, runs,
            // or schedules; treat it exactly like a SIGTERM (graceful shutdown +
            // state-file cleanup). onIdle is set now that `shutdown` exists, then
            // the monitor is (re)armed (listen() started it before onIdle existed).
            gateway.onIdle = () => shutdown();
            gateway.startIdleMonitor();
            process.stderr.write(`[smithers] Idle spin-down: exits after ${Math.round(idleTimeoutMs / 1000)}s idle (no clients, runs, or schedules)\n`);
        }
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    });
    return { url, workspace, dbPath, workflows };
}
const workflowCli = Cli.create({
    name: "workflow",
    description: "Discover local workflows from .smithers/workflows.",
})
    .command("run", {
    description: "Run a discovered workflow by ID. Omit the ID (or pass --interactive) to pick one interactively.",
    args: workflowRunArgs,
    options: workflowRunOptions,
    alias: { detach: "d", runId: "r", input: "i", maxConcurrency: "c", prompt: "p" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const mode = interactiveLaunchMode(c.options, Boolean(c.args.name), c.format);
            if (mode === "needs-tty") {
                return fail({ code: "INTERACTIVE_REQUIRES_TTY", message: "--interactive needs an interactive terminal (TTY) and human output; it cannot be combined with --format json/jsonl.", exitCode: 4 });
            }
            if (mode === "missing-arg") {
                return fail({ code: "WORKFLOW_REQUIRED", message: "Provide a workflow ID, or pass --interactive to pick one.", exitCode: 4 });
            }
            if (mode === "interactive") {
                const preselect = c.args.name ? resolveWorkflow(c.args.name, process.cwd()) : undefined;
                return runTuiCommand(c, fail, { preselect });
            }
            const workflow = resolveWorkflow(c.args.name, process.cwd());
            return executeUpCommand(c, workflow.entryFile, normalizeWorkflowRunOptions(c.options), fail);
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({
                    code: err.code,
                    message: err.message,
                    exitCode: 4,
                });
            }
            return fail({
                code: "WORKFLOW_RUN_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    .command("list", {
    description: "List discovered local workflows. System workflows are hidden unless --system is passed.",
    options: workflowListOptions,
    run(c) {
        const workflows = discoverWorkflows(process.cwd());
        return c.ok({
            workflows: c.options.system ? workflows : workflows.filter((workflow) => !workflow.system),
        }, {
            cta: buildAgentNextSteps({}),
        });
    },
})
    .command("path", {
    description: "Resolve a workflow ID to its entry file.",
    args: workflowPathArgs,
    run(c) {
        const workflow = resolveWorkflow(c.args.name, process.cwd());
        return c.ok({
            id: workflow.id,
            path: workflow.entryFile,
            sourceType: workflow.sourceType,
        });
    },
})
    .command("create", {
    description: "Create a new flat workflow scaffold in .smithers/workflows (or the global ~/.smithers with --global).",
    args: workflowPathArgs,
    options: workflowCreateOptions,
    run(c) {
        const fail = makeFail(c);
        try {
            const created = createWorkflowFile(c.args.name, process.cwd(), { global: c.options.global });
            return c.ok(created, {
                cta: buildAgentNextSteps({
                    workflowId: c.args.name,
                    workflowFile: created?.entryFile ?? created?.path,
                }),
            });
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({
                    code: err.code,
                    message: err.message,
                    exitCode: 4,
                });
            }
            return fail({
                code: "WORKFLOW_CREATE_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    .command("inspect", {
    description: "Show workflow metadata and an agent-facing skill preview.",
    args: workflowPathArgs,
    async run(c) {
        const workflow = resolveWorkflow(c.args.name, process.cwd());
        const loaded = await loadWorkflow(workflow.entryFile);
        const inputSchema = summarizeWorkflowInputSchema(workflowInputJsonSchema(loaded.inputSchema));
        return c.ok({
            workflow,
            inputSchema,
            skillPreview: renderWorkflowSkill(workflow, { root: process.cwd(), inputSchema }),
        }, {
            cta: buildAgentNextSteps({
                workflowId: workflow.id,
                workflowFile: workflow.entryFile,
            }),
        });
    },
})
    .command("skills", {
    description: "Generate agent-facing skill docs for local workflows.",
    args: workflowSkillArgs,
    options: workflowSkillOptions,
    async run(c) {
        const fail = makeFail(c);
        try {
            const workflowId = c.args.name ?? "all";
            const workflows = workflowId === "all"
                ? discoverWorkflows(process.cwd()).filter((workflow) => workflow.id !== "workflow-skill" && !workflow.system)
                : [resolveWorkflow(workflowId, process.cwd())];
            const inputSchemas = new Map();
            for (const workflow of workflows) {
                const loaded = await loadWorkflow(workflow.entryFile);
                inputSchemas.set(workflow.id, summarizeWorkflowInputSchema(workflowInputJsonSchema(loaded.inputSchema)));
            }
            const result = writeWorkflowSkillFiles(process.cwd(), {
                workflowId,
                output: c.options.output,
                force: c.options.force,
                global: c.options.global,
                inputSchemas,
            });
            return c.ok(result, {
                cta: {
                    description: result.nextSteps,
                    commands: [],
                },
            });
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({
                    code: err.code,
                    message: err.message,
                    exitCode: 4,
                });
            }
            return fail({
                code: "WORKFLOW_SKILLS_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    .command("doctor", {
    description: "Inspect workflow discovery, preload files, and detected agents.",
    args: workflowDoctorArgs,
    run(c) {
        const workflows = c.args.name
            ? [resolveWorkflow(c.args.name, process.cwd())]
            : discoverWorkflows(process.cwd());
        const packs = resolvePackDirs(process.cwd()).map(({ scope, packDir }) => ({
            scope,
            packDir,
            preload: {
                path: resolve(packDir, "preload.ts"),
                exists: existsSync(resolve(packDir, "preload.ts")),
            },
            bunfig: {
                path: resolve(packDir, "bunfig.toml"),
                exists: existsSync(resolve(packDir, "bunfig.toml")),
            },
        }));
        // Primary local pack (nearest .smithers, walking up) for back-compat fields.
        const localPack = packs.find((pack) => pack.scope === "local");
        const workflowRoot = localPack?.packDir ?? resolve(process.cwd(), ".smithers");
        const vcs = vcsToolingStatus();
        if (!vcs.ok && c.format !== "json") {
            process.stderr.write(
                `${pc.yellow("⚠ No jj or git found.")} Smithers needs one to snapshot and isolate agent work.\n` +
                `  Smithers bundles jj via the optional @smithers-orchestrator/jj-<platform> package; if it could not\n` +
                `  install for your platform, install jj (https://github.com/jj-vcs/jj) or git, or set SMITHERS_JJ_PATH.\n`,
            );
        }
        return c.ok({
            vcs,
            workflowRoot,
            packs,
            workflows,
            preload: localPack?.preload ?? {
                path: resolve(workflowRoot, "preload.ts"),
                exists: existsSync(resolve(workflowRoot, "preload.ts")),
            },
            bunfig: localPack?.bunfig ?? {
                path: resolve(workflowRoot, "bunfig.toml"),
                exists: existsSync(resolve(workflowRoot, "bunfig.toml")),
            },
            agents: detectAvailableAgents(process.env, { cwd: process.cwd() }),
        });
    },
});
const cronPathArgs = z.object({
    pattern: z.string().describe("Cron execution pattern (e.g. '0 * * * *')"),
    workflowPath: z.string().describe("Path or ID of the workflow to schedule"),
});
function validateCronPattern(pattern) {
    try {
        CronExpressionParser.parse(pattern);
        return undefined;
    }
    catch (err) {
        return err?.message ?? String(err);
    }
}
// ---------------------------------------------------------------------------
// smithers memory ...
// ---------------------------------------------------------------------------
const memoryListArgs = z.object({
    namespace: z
        .string()
        .optional()
        .describe("Namespace to list facts for (e.g. 'workflow:my-flow'). Omit to list every namespace."),
});
const memoryListOptions = z.object({
    workflow: z.string().optional().describe("Path to a .tsx workflow file (defaults to this workspace's store)"),
});
/**
 * Resolve a workflow-like handle (carrying the bun:sqlite `.db`) for the memory
 * commands. Memory facts live in the shared WORKSPACE store, not in any single
 * workflow, so `--workflow` is optional: with no flag we open the workspace
 * store directly (the same DB `ps`/`inspect` read), which is what lets
 * `smithers memory set workflow:ns key value` work right after `init` without
 * pointing at an arbitrary `.tsx`.
 *
 * @param {string | undefined} workflowPath
 */
async function resolveMemoryWorkflowAsync(workflowPath) {
    if (workflowPath)
        return loadWorkflowAsync(workflowPath);
    // Every workflow in the pack opens the same shared `.smithers/smithers.db`,
    // so default to any discovered workflow file (preferring the seeded `hello`)
    // rather than forcing the user to name one for a workspace-scoped read/write.
    const cwd = cliWorkspace.cwd();
    const localPackDir = resolvePackDirs(cwd).find((dir) => dir.scope === "local")?.packDir;
    const workspace = localPackDir ? dirname(localPackDir) : cwd;
    const discovered = discoverWorkflows(workspace).filter((w) => w.entryFile);
    const entry = discovered.find((w) => w.id === "hello") ?? discovered[0];
    if (!entry?.entryFile)
        throw new SmithersError("CLI_DB_NOT_FOUND", "No workflow found to resolve this workspace's store. Run `smithers init`, or pass --workflow <file>.");
    return loadWorkflowAsync(entry.entryFile);
}
/**
 * Shared setup for every `smithers memory` subcommand: resolve the workspace
 * workflow, open its store, and register sqlite cleanup. The imports stay
 * dynamic so the memory package is only loaded when a memory command runs.
 *
 * @param {string | undefined} workflowPath
 * @param {{ readOnly?: boolean }} [options]
 */
async function openMemoryStore(workflowPath, options = {}) {
    const { createMemoryStore } = await import("@smithers-orchestrator/memory/store");
    const { parseNamespace } = await import("@smithers-orchestrator/memory/types");
    if (!workflowPath && options.readOnly && cliWorkspace.usesManifestFallback()) {
        const opened = await findAndOpenDb();
        return { store: createMemoryStore(opened.db), parseNamespace, cleanup: opened.cleanup };
    }
    const workflow = await resolveMemoryWorkflowAsync(workflowPath);
    ensureSmithersTables(workflow.db);
    setupSqliteCleanup(workflow);
    return { store: createMemoryStore(workflow.db), parseNamespace, cleanup: undefined };
}
const memoryCli = Cli.create({
    name: "memory",
    description: "View and query cross-run memory facts.",
})
    .command("list", {
    description: "List all memory facts in a namespace.",
    args: memoryListArgs,
    options: memoryListOptions,
    alias: { workflow: "w" },
    async run(c) {
        let cleanup;
        try {
            const opened = await openMemoryStore(c.options.workflow, { readOnly: true });
            const { store, parseNamespace } = opened;
            cleanup = opened.cleanup;
            const printFact = (f) => {
                const value = f.valueJson.length > 100 ? f.valueJson.slice(0, 100) + "..." : f.valueJson;
                const age = formatAge(f.updatedAtMs);
                console.log(`  ${pc.bold(f.key)} = ${value}  ${pc.dim(`(${age})`)}`);
            };
            // No namespace → list every fact across all namespaces, grouped by namespace.
            if (c.args.namespace === undefined) {
                const facts = await store.listAllFacts();
                if (facts.length === 0) {
                    console.log("No memory facts found in this workspace.");
                    return c.ok({ facts: [], namespace: null });
                }
                let current = null;
                for (const f of facts) {
                    if (f.namespace !== current) {
                        current = f.namespace;
                        console.log(pc.cyan(current));
                    }
                    printFact(f);
                }
                return c.ok({ facts, namespace: null });
            }
            const ns = parseNamespace(c.args.namespace);
            const facts = await store.listFacts(ns);
            if (facts.length === 0) {
                console.log(`No facts found in namespace "${c.args.namespace}".`);
                return c.ok({ facts: [], namespace: c.args.namespace });
            }
            for (const f of facts) {
                printFact(f);
            }
            return c.ok({ facts, namespace: c.args.namespace });
        }
        catch (err) {
            console.error(`Error: ${err?.message ?? String(err)}`);
            return c.error({ code: "MEMORY_LIST_FAILED", message: err?.message ?? String(err) });
        }
        finally {
            await cleanup?.();
        }
    },
})
    .command("get", {
    description: "Get a single memory fact by namespace + key.",
    args: z.object({
        namespace: z.string().describe("Namespace (e.g. 'workflow:my-flow')"),
        key: z.string().describe("Fact key"),
    }),
    options: memoryListOptions,
    alias: { workflow: "w" },
    async run(c) {
        let cleanup;
        try {
            const opened = await openMemoryStore(c.options.workflow, { readOnly: true });
            const { store, parseNamespace } = opened;
            cleanup = opened.cleanup;
            const fact = await store.getFact(parseNamespace(c.args.namespace), c.args.key);
            if (!fact) {
                console.log(`No fact "${c.args.key}" in namespace "${c.args.namespace}".`);
                return c.ok({ fact: null, namespace: c.args.namespace, key: c.args.key });
            }
            console.log(fact.valueJson);
            return c.ok({ fact, namespace: c.args.namespace, key: c.args.key });
        }
        catch (err) {
            console.error(`Error: ${err?.message ?? String(err)}`);
            return c.error({ code: "MEMORY_GET_FAILED", message: err?.message ?? String(err) });
        }
        finally {
            await cleanup?.();
        }
    },
})
    .command("set", {
    description: "Set a memory fact (value is stored verbatim as the fact's JSON value).",
    args: z.object({
        namespace: z.string().describe("Namespace (e.g. 'workflow:my-flow')"),
        key: z.string().describe("Fact key"),
        value: z.string().describe("Fact value (stored as-is)"),
    }),
    options: memoryListOptions.extend({
        ttl: z.coerce.number().int().positive().optional().describe("Time-to-live in milliseconds"),
    }),
    alias: { workflow: "w" },
    async run(c) {
        try {
            const { store, parseNamespace } = await openMemoryStore(c.options.workflow);
            const trimmedValue = c.args.value.trim();
            let factValue = c.args.value;
            if (trimmedValue.startsWith("{") || trimmedValue.startsWith("[")) {
                try {
                    const parsed = JSON.parse(c.args.value);
                    if (parsed !== null && typeof parsed === "object") {
                        factValue = parsed;
                    }
                }
                catch {
                    factValue = c.args.value;
                }
            }
            await store.setFact(parseNamespace(c.args.namespace), c.args.key, factValue, c.options.ttl);
            console.log(`Set ${pc.bold(c.args.key)} in "${c.args.namespace}".`);
            return c.ok({ namespace: c.args.namespace, key: c.args.key });
        }
        catch (err) {
            console.error(`Error: ${err?.message ?? String(err)}`);
            return c.error({ code: "MEMORY_SET_FAILED", message: err?.message ?? String(err) });
        }
    },
})
    .command("rm", {
    description: "Delete a memory fact by namespace + key.",
    args: z.object({
        namespace: z.string().describe("Namespace (e.g. 'workflow:my-flow')"),
        key: z.string().describe("Fact key"),
    }),
    options: memoryListOptions,
    alias: { workflow: "w" },
    async run(c) {
        try {
            const { store, parseNamespace } = await openMemoryStore(c.options.workflow);
            await store.deleteFact(parseNamespace(c.args.namespace), c.args.key);
            console.log(`Deleted ${pc.bold(c.args.key)} from "${c.args.namespace}".`);
            return c.ok({ namespace: c.args.namespace, key: c.args.key });
        }
        catch (err) {
            console.error(`Error: ${err?.message ?? String(err)}`);
            return c.error({ code: "MEMORY_RM_FAILED", message: err?.message ?? String(err) });
        }
    },
});
// ---------------------------------------------------------------------------
// `smithers claude ...` — protocol commands behind the Claude Code plugin's
// /workflows mirror. Machine-shaped, contract-versioned (`contract` field):
// the plugin's generic mirror script pins the shape, so keep changes additive.
// ---------------------------------------------------------------------------
const claudeTickArgs = z.object({
    runId: z.string().describe("Run ID to mirror"),
});
const claudeTickOptions = z.object({
    afterSeq: z.number().int().min(0).default(0).describe("Event-log cursor from the previous tick's `seq`"),
    wait: z.boolean().default(false).describe("Block until a mirror-relevant event lands after --after-seq (or timeout)"),
    timeoutMs: z.number().int().min(0).default(420000).describe("Max wait in ms before returning timedOut: true"),
    intervalMs: z.number().int().min(100).default(750).describe("Wait poll interval in ms"),
    maxOutputChars: z.number().int().min(0).default(2000).describe("Truncate node outputs to this many chars"),
    collapsePhases: z.boolean().default(false).describe("Collapse the phase plan to a single phase"),
});
const claudeNodeWaitArgs = z.object({
    nodeId: z.string().describe("Node ID to wait on"),
});
const claudeNodeWaitOptions = z.object({
    runId: z.string().describe("Run ID that owns the node"),
    iteration: z.number().int().min(0).optional().describe("Loop iteration (default: latest)"),
    timeoutMs: z.number().int().min(0).default(480000).describe("Max wait in ms before returning timedOut: true"),
    intervalMs: z.number().int().min(100).default(1000).describe("Poll interval in ms"),
    maxOutputChars: z.number().int().min(0).default(2000).describe("Truncate the node output to this many chars"),
});
const claudeMonitorOptions = z.object({
    intervalMs: z.number().int().min(250).default(2000).describe("Poll interval in ms"),
    stalledAfterMs: z.number().int().min(5000).default(120000).describe("Heartbeat age that flags a running run as stalled"),
    ticks: z.number().int().min(1).optional().describe("Stop after N polls (default: run until killed)"),
    transitions: z.enum(["actionable", "all"]).default("actionable").describe("Which transitions stream: actionable (approvals, human requests, failures, stalls) or all (also finished/cancelled/continued)"),
    allRuns: z.boolean().default(false).describe("Follow every run in the workspace instead of only the runs this session subscribed to (via claude tick / claude subscribe)"),
});
const claudeSubscribeArgs = z.object({
    runId: z.string().describe("Run ID the session's monitor should follow"),
});
const claudeCli = Cli.create({
    name: "claude",
    description: "Protocol commands for the Claude Code plugin: mirror runs into /workflows and notify the session.",
})
    .command("tick", {
    description: "One /workflows mirror frame for a run: status, phase plan, nodes, deltas since --after-seq, outputs, approvals. --wait blocks until something relevant changes.",
    args: claudeTickArgs,
    options: claudeTickOptions,
    alias: {
        afterSeq: "after-seq",
        timeoutMs: "timeout-ms",
        intervalMs: "interval-ms",
        maxOutputChars: "max-output-chars",
        collapsePhases: "collapse-phases",
    },
    async run(c) {
        const fail = makeFail(c);
        try {
            // With --wait, the store and the run are allowed to not exist YET:
            // a mirror launched right after `workflow run --detach` races the
            // detached engine's first write, so block until they appear (or the
            // timeout budget runs out) instead of failing the first tick.
            const deadline = Date.now() + (c.options.wait ? c.options.timeoutMs : 0);
            let opened;
            while (true) {
                try {
                    opened = await findAndOpenDb();
                    break;
                }
                catch (err) {
                    if (!c.options.wait || Date.now() >= deadline) {
                        throw err;
                    }
                    await new Promise((resolveSleep) => setTimeout(resolveSleep, c.options.intervalMs));
                }
            }
            const { adapter, cleanup } = opened;
            try {
                let timedOut = false;
                if (c.options.wait) {
                    while (!(await adapter.getRun(c.args.runId)) && Date.now() < deadline) {
                        await new Promise((resolveSleep) => setTimeout(resolveSleep, c.options.intervalMs));
                    }
                    const waited = await waitForClaudeMirrorChange(adapter, c.args.runId, {
                        afterSeq: c.options.afterSeq,
                        timeoutMs: Math.max(0, deadline - Date.now()),
                        intervalMs: c.options.intervalMs,
                    });
                    timedOut = waited.timedOut;
                }
                const tick = await buildClaudeMirrorTick(adapter, c.args.runId, {
                    afterSeq: c.options.afterSeq,
                    maxOutputChars: c.options.maxOutputChars,
                    collapsePhases: c.options.collapsePhases,
                });
                // Ticking a run IS the session following it: record the
                // subscription so `claude monitor` notifies about this run (and
                // only runs followed this way). Terminal runs are history, not
                // something to watch.
                if (!isTerminalClaudeMirrorRunStatus(tick.status)) {
                    upsertClaudeMirrorSubscription(resolveClaudeMirrorSubscriptionsPath(opened.choice.workspaceRoot), {
                        runId: c.args.runId,
                        sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
                        nowMs: Date.now(),
                    });
                }
                return c.ok({ ...tick, timedOut });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: err.code === "RUN_NOT_FOUND" ? 4 : 1 });
            }
            return fail({ code: "CLAUDE_TICK_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    .command("node-wait", {
    description: "Block until one node reaches a terminal state, then print its final state and output. Returns timedOut: true on --timeout-ms expiry (re-invoke to keep waiting).",
    args: claudeNodeWaitArgs,
    options: claudeNodeWaitOptions,
    alias: {
        runId: "run-id",
        iteration: "i",
        timeoutMs: "timeout-ms",
        intervalMs: "interval-ms",
        maxOutputChars: "max-output-chars",
    },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const result = await buildClaudeNodeWait(adapter, {
                    runId: c.options.runId,
                    nodeId: c.args.nodeId,
                    iteration: c.options.iteration,
                    timeoutMs: c.options.timeoutMs,
                    intervalMs: c.options.intervalMs,
                    maxOutputChars: c.options.maxOutputChars,
                });
                return c.ok(result);
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: err.code === "RUN_NOT_FOUND" ? 4 : 1 });
            }
            return fail({ code: "CLAUDE_NODE_WAIT_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    .command("monitor", {
    description: "Follow the runs this session subscribed to (claude tick / claude subscribe) and print one NDJSON line per actionable transition (approval pending, human request, failed, stalled); --transitions all adds finished/cancelled/continued, --all-runs follows every run in the workspace. Backs the plugin's background monitor.",
    options: claudeMonitorOptions,
    alias: {
        intervalMs: "interval-ms",
        stalledAfterMs: "stalled-after-ms",
        allRuns: "all-runs",
    },
    async run(c) {
        let opened;
        try {
            opened = await findAndOpenDb();
        }
        catch {
            // No smithers store here: the plugin monitor runs in every session,
            // so a non-smithers project exits clean and silent by design.
            return c.ok(undefined);
        }
        try {
            await runClaudeMonitor(opened.adapter, {
                intervalMs: c.options.intervalMs,
                stalledAfterMs: c.options.stalledAfterMs,
                ticks: c.options.ticks,
                transitions: c.options.transitions,
                // The workspace store is shared across sessions; only runs this
                // session follows may notify it, unless --all-runs opts out.
                ...(c.options.allRuns ? {} : {
                    subscriptionsPath: resolveClaudeMirrorSubscriptionsPath(opened.choice.workspaceRoot),
                    sessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined,
                }),
            });
            return c.ok(undefined);
        }
        finally {
            opened.cleanup();
        }
    },
})
    .command("subscribe", {
    description: "Subscribe this session's background monitor to a run (done automatically by `claude tick` and Claude-launched runs); the monitor only notifies about subscribed runs.",
    args: claudeSubscribeArgs,
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup, choice } = await findAndOpenDb();
            try {
                const run = await adapter.getRun(c.args.runId);
                if (!run) {
                    return fail({ code: "RUN_NOT_FOUND", message: `Run ${c.args.runId} not found in this workspace.`, exitCode: 4 });
                }
                const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
                const subscriptionsPath = resolveClaudeMirrorSubscriptionsPath(choice.workspaceRoot);
                upsertClaudeMirrorSubscription(subscriptionsPath, { runId: c.args.runId, sessionId, nowMs: Date.now() });
                return c.ok({ runId: c.args.runId, sessionId, subscriptionsPath });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: 1 });
            }
            return fail({ code: "CLAUDE_SUBSCRIBE_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    .command("unsubscribe", {
    description: "Stop this session's background monitor from following a run (outside a Claude Code session it drops the run for every session).",
    args: claudeSubscribeArgs,
    async run(c) {
        const fail = makeFail(c);
        try {
            const { cleanup, choice } = await findAndOpenDb();
            try {
                // Session-scoped when a session id is present; a human at a
                // terminal (no session id) means "stop notifying anyone".
                const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
                const subscriptionsPath = resolveClaudeMirrorSubscriptionsPath(choice.workspaceRoot);
                const removed = removeClaudeMirrorSubscription(subscriptionsPath, {
                    runId: c.args.runId,
                    ...(sessionId ? { sessionId } : {}),
                });
                return c.ok({ runId: c.args.runId, sessionId: sessionId ?? null, removed, subscriptionsPath });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: 1 });
            }
            return fail({ code: "CLAUDE_UNSUBSCRIBE_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
});
const cronCli = Cli.create({
    name: "cron",
    description: "Manage and run background schedule triggers.",
})
    .command("start", {
    description: "Start the background scheduler loop in the current terminal.",
    async run(c) {
        await runScheduler();
        return c.ok({ status: "running" });
    },
})
    .command("add", {
    description: "Register a new workflow cron schedule.",
    args: cronPathArgs,
    async run(c) {
        const fail = makeFail(c);
        const cronError = validateCronPattern(c.args.pattern);
        if (cronError) {
            return fail({
                code: "INVALID_CRON_PATTERN",
                message: `Invalid cron pattern '${c.args.pattern}': ${cronError}`,
                exitCode: 4,
            });
        }
        const { adapter, cleanup } = await findAndOpenDb();
        try {
            const cronId = crypto.randomUUID();
            await adapter.upsertCron({
                cronId,
                pattern: c.args.pattern,
                workflowPath: c.args.workflowPath,
                enabled: true,
                createdAtMs: Date.now(),
                lastRunAtMs: null,
                nextRunAtMs: null,
                errorJson: null,
            });
            console.log(`[+] Scheduled ${c.args.workflowPath} with pattern '${c.args.pattern}'`);
            return c.ok({ cronId, pattern: c.args.pattern, workflowPath: c.args.workflowPath });
        }
        finally {
            cleanup();
        }
    },
})
    .command("list", {
    description: "List all registered background cron schedules.",
    async run(c) {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
            const crons = await adapter.listCrons(false);
            return c.ok({ crons });
        }
        finally {
            cleanup();
        }
    },
})
    .command("rm", {
    description: "Delete an existing cron schedule by ID.",
    args: z.object({ cronId: z.string().describe("Cron ID to delete") }),
    async run(c) {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
            await adapter.deleteCron(c.args.cronId);
            console.log(`[-] Deleted cron ${c.args.cronId}`);
            return c.ok({ deleted: c.args.cronId });
        }
        finally {
            cleanup();
        }
    },
});
const agentsCli = Cli.create({
    name: "agents",
    description: "Inspect and register subscriptions and api keys.",
})
    .command("capabilities", {
    description: "Print a JSON report of the built-in CLI agent capability registries.",
    run(c) {
        process.stdout.write(`${JSON.stringify(getCliAgentCapabilityReport(), null, 2)}\n`);
        return c.ok(undefined);
    },
})
    .command("doctor", {
    description: "Validate built-in CLI agent capability registries and command-surface contracts.",
    options: z.object({
        json: z.boolean().default(false).describe("Print the doctor report as JSON"),
    }),
    run(c) {
        const report = getCliAgentCapabilityDoctorReport();
        commandExitOverride = report.ok ? 0 : 1;
        if (c.options.json || c.format === "json") {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        }
        else {
            process.stdout.write(`${formatCliAgentCapabilityDoctorReport(report)}\n`);
        }
        return c.ok(undefined);
    },
})
    .command("add", {
    description: "Register a Smithers agent account (interactive wizard, or non-interactive via flags).",
    options: z.object({
        provider: z.enum([
            "claude-code", "antigravity", "codex", "kimi",
            "anthropic-api", "openai-api", "gemini-api",
        ]).optional().describe("Provider id; omit to launch the interactive wizard"),
        label: z.string().optional().describe("Unique label, e.g. 'claude-work'"),
        configDir: z.string().optional().describe("Path to the per-account CLI config dir (subscription providers)"),
        apiKey: z.string().optional().describe("API key (api-key providers only)"),
        model: z.string().optional().describe("Default model for this account"),
        skipLogin: z.boolean().default(false).describe("Skip the 'is the dir populated?' check (advanced)"),
        force: z.boolean().default(false).describe("Register even if no credentials are present"),
        replace: z.boolean().default(false).describe("Overwrite an existing account with the same label"),
        loop: z.boolean().default(false).describe("Wizard mode only: keep adding accounts until you say done"),
    }),
    async run(c) {
        // Flag-driven mode: provider+label given → just register.
        if (c.options.provider && c.options.label) {
            try {
                const result = runAgentAdd({
                    provider: c.options.provider,
                    label: c.options.label,
                    configDir: c.options.configDir,
                    apiKey: c.options.apiKey,
                    model: c.options.model,
                    skipLogin: c.options.skipLogin,
                    force: c.options.force,
                    replace: c.options.replace,
                });
                if (!result.ok) {
                    const code = result.reason === "login-required" ? 2 : 1;
                    commandExitOverride = code;
                    return c.error({
                        code: result.reason === "login-required"
                            ? "AGENT_LOGIN_REQUIRED"
                            : "AGENT_ADD_FAILED",
                        message: result.detail ?? result.reason,
                        exitCode: code,
                    });
                }
                return c.ok({
                    account: result.account,
                    regen: result.regen,
                });
            }
            catch (err) {
                commandExitOverride = 1;
                return c.error({
                    code: err?.code ?? "AGENT_ADD_FAILED",
                    message: err?.message ?? String(err),
                    exitCode: 1,
                });
            }
        }
        // Interactive wizard mode.
        const labels = await agentAddWizard({ loop: c.options.loop });
        return c.ok({ added: labels });
    },
})
    .command("list", {
    description: "List all registered Smithers agent accounts. Use --format json for machine output.",
    run(c) {
        const accounts = listAccounts();
        if (accounts.length === 0) {
            process.stderr.write("No accounts registered. Add one with `smithers agents add`.\n");
            return c.ok({ accounts });
        }
        const rows = accounts.map((a) => {
            const where = a.configDir ?? (a.apiKey ? "(api key set)" : "");
            return `  ${a.label.padEnd(24)}  ${a.provider.padEnd(14)}  ${where}`;
        });
        process.stderr.write(`Registered accounts (${accounts.length}):\n${rows.join("\n")}\n`);
        return c.ok({ accounts });
    },
})
    .command("remove", {
    description: "Remove a Smithers agent account by label.",
    args: z.object({ label: z.string().describe("Account label to remove") }),
    options: z.object({
        silent: z.boolean().default(false).describe("Do not error if the label is not registered"),
    }),
    async run(c) {
        try {
            const removed = removeAccount(c.args.label, { silent: c.options.silent });
            if (removed) {
                const { regenerateAgentsTsIfPresent } = await import("./agent-commands/regenerateAgentsTsIfPresent.js");
                const regen = regenerateAgentsTsIfPresent();
                process.stdout.write(`Removed ${c.args.label}.\n`);
                return c.ok({ removed: true, label: c.args.label, regen });
            }
            return c.ok({ removed: false, label: c.args.label });
        }
        catch (err) {
            commandExitOverride = 1;
            return c.error({
                code: err?.code ?? "AGENT_REMOVE_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    .command("test", {
    description: "Spawn the account's underlying CLI with --version to verify it is reachable.",
    args: z.object({ label: z.string().describe("Account label to ping") }),
    run(c) {
        const account = listAccounts().find((a) => a.label === c.args.label);
        if (!account) {
            commandExitOverride = 1;
            return c.error({
                code: "ACCOUNT_NOT_FOUND",
                message: `No account with label "${c.args.label}" is registered.`,
                exitCode: 1,
            });
        }
        const ping = pingAccount(account);
        process.stdout.write(`Ran: ${ping.cmd}\nExit: ${ping.exitCode ?? "<n/a>"}\n`);
        if (ping.ran && ping.exitCode !== 0) commandExitOverride = 1;
        return c.ok({ account, ping });
    },
});
// ---------------------------------------------------------------------------
// OpenAPI subcommand
// ---------------------------------------------------------------------------
const openapiListArgs = z.object({
    specPath: z.string().describe("Path or URL to an OpenAPI spec"),
});
const openapiGenerateArgs = z.object({
    specPath: z.string().describe("Path to an OpenAPI spec"),
    outputPath: z.string().describe("Output JavaScript file for generated tools"),
});
const openapiCli = Cli.create({
    name: "openapi",
    description: "Generate AI SDK tools from OpenAPI specs.",
})
    .command("list", {
    description: "Preview tools that would be generated from an OpenAPI spec.",
    args: openapiListArgs,
    async run(c) {
        try {
            const { listOperations } = await import("@smithers-orchestrator/openapi/tool-factory");
            const ops = listOperations(c.args.specPath);
            if (ops.length === 0) {
                console.log("  No operations found in spec.");
                return c.ok({ operations: [] });
            }
            for (const op of ops) {
                console.log(`  ${pc.bold(op.operationId)} — ${op.summary || `${op.method} ${op.path}`}`);
            }
            console.log(`\n  ${ops.length} tool(s) from spec`);
            return c.ok({ operations: ops });
        }
        catch (err) {
            console.error(`Error: ${err?.message ?? String(err)}`);
            return c.error({ code: "OPENAPI_LIST_FAILED", message: err?.message ?? String(err) });
        }
    },
})
    .command("generate", {
    description: "Generate an AI SDK tools module from an OpenAPI spec.",
    args: openapiGenerateArgs,
    async run(c) {
        try {
            const { createOpenApiToolsSync } = await import("@smithers-orchestrator/openapi/tool-factory");
            const specPath = resolve(process.cwd(), c.args.specPath);
            const outputPath = resolve(process.cwd(), c.args.outputPath);
            const outputDir = dirname(outputPath);
            // Backslash normalization keeps the generated import specifier
            // portable when the CLI runs on Windows paths.
            const rel = relative(outputDir, specPath).split("\\").join("/");
            const importPath = rel.startsWith(".") ? rel : `./${rel}`;
            const tools = createOpenApiToolsSync(specPath);
            const toolCount = Object.keys(tools).length;
            mkdirSync(outputDir, { recursive: true });
            writeFileSync(outputPath, [
                'import { fileURLToPath } from "node:url";',
                'import { createOpenApiToolsSync } from "smithers-orchestrator/openapi";',
                "",
                `const specPath = fileURLToPath(new URL(${JSON.stringify(importPath)}, import.meta.url));`,
                "",
                "export const tools = createOpenApiToolsSync(specPath);",
                "",
                "export default tools;",
                "",
            ].join("\n"), "utf8");
            console.log(`Generated ${toolCount} OpenAPI tool(s) at ${outputPath}`);
            return c.ok({ outputPath, toolCount });
        }
        catch (err) {
            console.error(`Error: ${err?.message ?? String(err)}`);
            return c.error({ code: "OPENAPI_GENERATE_FAILED", message: err?.message ?? String(err) });
        }
    },
});
const tokenCli = Cli.create({
    name: "token",
    description: "Issue and revoke short-lived Gateway bearer tokens.",
})
    .command("issue", {
    description: "Issue a local short-lived Gateway bearer token grant.",
    options: z.object({
        scopes: z.string().default("run:read").describe("Comma or space separated Gateway scopes"),
        role: z.string().default("operator").describe("Role recorded on the token grant"),
        userId: z.string().optional().describe("User id recorded on the token grant"),
        ttl: z.string().default("1h").describe("Token lifetime, such as 15m or 1h"),
        actionId: z.string().default("gateway").describe("Action id allowed to resolve the brokered action token"),
        revealToken: z.boolean().default(false).describe("Include the raw bearer token in CLI output"),
    }),
    run(c) {
        const fail = makeFail(c);
        try {
            const ttlMs = parseDurationMs(c.options.ttl, "ttl");
            const issued = issueSmithersBrokerToken({
                store: readSmithersTokenStore(),
                role: c.options.role,
                scopes: parseTokenScopes(c.options.scopes),
                ...(c.options.userId ? { userId: c.options.userId } : {}),
                actionId: c.options.actionId,
                ttlMs,
            });
            writeSmithersTokenStore(issued.store);
            return c.ok({
                ...(c.options.revealToken ? { token: issued.token } : {}),
                grant: c.options.revealToken ? issued.grant : { ...issued.grant, secret: undefined },
                actionToken: issued.actionToken,
                storePath: smithersTokenStorePath(),
            });
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError ? err.code : "TOKEN_ISSUE_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    .command("exec", {
    description: "Resolve an action token locally and inject the bearer into a child process environment.",
    options: z.object({
        handle: z.string().describe("Brokered action token handle"),
        actionId: z.string().default("gateway").describe("Action id expected by the brokered token"),
        scopes: z.string().default("").describe("Comma or space separated scopes required for this action"),
        env: z.string().default("SMITHERS_API_KEY").describe("Environment variable that receives the bearer token"),
        command: z.string().describe("Shell command to run with the injected token"),
    }),
    async run(c) {
        const fail = makeFail(c);
        try {
            const resolved = resolveSmithersActionTokenFromStore(c.options.handle, {
                actionId: c.options.actionId,
                scopes: parseTokenScopes(c.options.scopes),
            });
            const child = spawn(c.options.command, {
                shell: true,
                stdio: "inherit",
                env: {
                    ...process.env,
                    [c.options.env]: resolved.token,
                },
            });
            const exitCode = await new Promise((resolveExit) => {
                child.on("error", () => resolveExit(1));
                child.on("exit", (code, signal) => {
                    if (typeof code === "number")
                        resolveExit(code);
                    else
                        resolveExit(signal ? 1 : 0);
                });
            });
            commandExitOverride = exitCode;
            return exitCode === 0
                ? c.ok({ ok: true, tokenId: resolved.grant.tokenId, actionId: resolved.actionToken.actionId })
                : fail({ code: "TOKEN_EXEC_FAILED", message: `Command exited with status ${exitCode}`, exitCode });
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError ? err.code : "TOKEN_EXEC_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    .command("revoke", {
    description: "Revoke a locally issued Gateway bearer token.",
    args: z.object({
        token: z.string().describe("Bearer token to revoke"),
    }),
    run(c) {
        const store = readSmithersTokenStore();
        const grant = revokeSmithersToken(store, c.args.token);
        if (!grant) {
            commandExitOverride = 1;
            return c.error({
                code: "TOKEN_NOT_FOUND",
                message: "Token was not found in the local Smithers token store",
                exitCode: 1,
            });
        }
        writeSmithersTokenStore(store);
        return c.ok({
            revoked: true,
            tokenId: grant.tokenId,
            storePath: smithersTokenStorePath(),
        });
    },
});
/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
/**
 * @returns {string}
 */
function resolveWorktreeRootDir() {
    const vcs = findVcsRoot(process.cwd());
    if (!vcs) {
        throw new SmithersError("VCS_NOT_FOUND", `No git or jj repository found from ${process.cwd()}. Run \`smithers worktree\` inside a repository.`, { cwd: process.cwd() });
    }
    return vcs.root;
}
const worktreeCli = Cli.create({
    name: "worktree",
    description: "Inspect and reclaim the worktrees Smithers created for <Worktree> lanes.",
})
    .command("list", {
    description: "List every worktree Smithers created in this repository and the run that owns it.",
    async run(c) {
        const fail = makeFail(c);
        let rootDir;
        try {
            rootDir = resolveWorktreeRootDir();
        }
        catch (err) {
            return fail({ code: "VCS_NOT_FOUND", message: err?.message ?? String(err), exitCode: 1 });
        }
        const worktrees = await listSmithersWorktrees(rootDir);
        const { adapter, cleanup } = await findAndOpenDb();
        try {
            const rows = [];
            for (const worktree of worktrees) {
                const run = await adapter.getRun(worktree.owner.runId);
                rows.push({
                    path: worktree.path,
                    runId: worktree.owner.runId,
                    workflow: worktree.owner.workflowName ?? null,
                    status: run?.status ?? "unknown",
                    exists: worktree.exists,
                    updatedAtMs: worktree.owner.updatedAtMs,
                });
            }
            if (c.format !== "json") {
                if (rows.length === 0) {
                    console.log("No Smithers worktrees in this repository.");
                }
                for (const row of rows) {
                    console.log(`${row.status.padEnd(16)} ${row.runId}  ${row.path}${row.exists ? "" : "  (missing)"}`);
                }
            }
            return c.ok({ worktrees: rows });
        }
        finally {
            cleanup();
        }
    },
})
    .command("prune", {
    description: "Remove the worktrees of runs that are over (finished, failed, or cancelled).",
    options: z.object({
        run: z.string().optional().describe("Only prune worktrees owned by this run id"),
        olderThan: z.string().optional().describe("Only prune worktrees untouched for at least this long, e.g. 24h"),
        dryRun: z.boolean().default(false).describe("Report what would be removed without removing anything"),
        force: z.boolean().default(false).describe("Also remove worktrees holding uncommitted or unpushed work"),
    }),
    async run(c) {
        const fail = makeFail(c);
        let rootDir;
        let olderThanMs;
        try {
            rootDir = resolveWorktreeRootDir();
            olderThanMs = c.options.olderThan ? parseDurationMs(c.options.olderThan, "older-than") : undefined;
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError ? err.code : "WORKTREE_PRUNE_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
        const { adapter, cleanup } = await findAndOpenDb();
        try {
            const result = await reapWorktrees({
                rootDir,
                runId: c.options.run,
                force: c.options.force,
                dryRun: c.options.dryRun,
                olderThanMs,
                getRunStatus: async (runId) => (await adapter.getRun(runId))?.status ?? null,
            });
            if (c.format !== "json") {
                const verb = result.dryRun ? "Would remove" : "Removed";
                for (const entry of result.removed) {
                    console.log(`${verb} ${entry.path} (${entry.runId}, ${formatBytes(entry.bytes)})`);
                }
                for (const entry of result.skipped) {
                    console.log(`Keeping ${entry.path} (${entry.runId}): ${entry.reason}`);
                }
                console.log(`${verb.toLowerCase()} ${result.removed.length} worktree(s), ${formatBytes(result.bytesFreed)}${result.dryRun ? "" : " reclaimed"}.`);
                const unsaved = result.skipped.filter((entry) => entry.reason === "unsaved-work").length;
                if (unsaved > 0 && !c.options.force) {
                    console.log(`${unsaved} worktree(s) hold uncommitted or unpushed work and were kept. Pass --force to remove them anyway.`);
                }
            }
            return c.ok(result);
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError ? err.code : "WORKTREE_PRUNE_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
        finally {
            cleanup();
        }
    },
});
// ---------------------------------------------------------------------------
// DevTools live-run commands (tree / diff / output / rewind / snapshots / restore)
// ---------------------------------------------------------------------------

const DEVTOOLS_COMMANDS = new Set(["tree", "diff", "output", "rewind", "snapshots", "restore"]);

/**
 * Lets `main()` preserve devtools exit codes instead of Incur's generic
 * validation-code mapping.
 * @type {{ cmd: string; exitCode: number } | undefined}
 */
let lastDevtoolsCommandOutcome;

/**
 * Formats where a devtools command's stdout must stay a single machine-
 * parseable document. Bare `--json` is rewritten to the command-scoped `-j`
 * before parsing (rewriteDevtoolsJsonFlagArgv), so only an explicit global
 * `--format <fmt>` reaches this path. (#7)
 */
const DEVTOOLS_MACHINE_FORMATS = new Set(["json", "jsonl"]);

/**
 * Wrap the inner handler of a devtools command in structured telemetry.
 *
 * - Writes a JSON line to stderr when `SMITHERS_LOG_JSON=1` is set
 *   containing `{ cmd, runId, flags, durationMs, exitCode }`.
 * - Emits an `smithers_cli_command_total{cmd,exit}` counter and a
 *   `smithers_cli_command_duration_ms{cmd}` histogram via the
 *   observability package.
 *
 * Devtools commands own stdout (raw trees/diffs/rows), so under an explicit
 * global `--format` this wrapper also finishes the command itself instead of
 * returning control to incur: incur's streaming path would otherwise append
 * its own `{ok:true,data:[]}` envelope (rendered as `[]` or `{"cta":...}`)
 * after the payload -- and, on failure, print that success-shaped document on
 * stdout while the real error went to stderr as prose. For json/jsonl a
 * failure is re-emitted as a structured `{code, message}` envelope on stdout
 * (parsed back out of the formatCliErrorForStderr text the handler wrote to
 * the captured stderr); exit codes are preserved as-is. (#7)
 *
 * @param {"tree"|"diff"|"output"|"rewind"|"snapshots"|"restore"} cmd
 * @param {{ args: any; options: any; format?: string; formatExplicit?: boolean }} c
 * @param {(io: { stdout: { write: (s: string) => unknown; isTTY?: boolean | undefined }; stderr: { write: (s: string) => unknown; isTTY?: boolean | undefined } }) => Promise<number>} handler
 */
async function* runDevtoolsCommandWithTelemetry(cmd, c, handler) {
    const startedAt = Date.now();
    const ownsCompletion = Boolean(c.formatExplicit);
    const machineFormat = ownsCompletion && DEVTOOLS_MACHINE_FORMATS.has(c.format ?? "");
    let capturedStderr = "";
    const io = ownsCompletion
        ? {
            // Synchronous stdout so the payload is fully flushed before the
            // direct process.exit below (an async process.stdout.write racing
            // process.exit truncates >64KB pipes).
            stdout: {
                write: (chunk) => {
                    writeStdoutSync(String(chunk));
                    return true;
                },
                isTTY: process.stdout.isTTY,
            },
            stderr: {
                write: (chunk) => {
                    capturedStderr += String(chunk);
                    process.stderr.write(String(chunk));
                    return true;
                },
                isTTY: process.stderr.isTTY,
            },
        }
        : { stdout: process.stdout, stderr: process.stderr };
    if (machineFormat && c.options && typeof c.options === "object" && "json" in c.options) {
        // An explicit global --format json/jsonl asks for the machine payload:
        // behave exactly like the command-scoped --json/-j so the raw JSON
        // document (snapshot/DiffBundle/row/JumpResult/rows) is what lands on
        // stdout instead of the human render.
        c.options.json = true;
    }
    let exitCode = 0;
    let thrownMessage;
    try {
        exitCode = await handler(io);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        thrownMessage = message;
        process.stderr.write(`error: ${cmd} failed: ${message}\n`);
        exitCode = 2;
    }
    const durationMs = Date.now() - startedAt;
    commandExitOverride = exitCode;
    lastDevtoolsCommandOutcome = { cmd, exitCode };
    if (process.env.SMITHERS_LOG_JSON === "1") {
        try {
            const runId = typeof c.args?.runId === "string" ? c.args.runId : undefined;
            const flags = c.options ?? {};
            const line = JSON.stringify({
                level: "info",
                cmd,
                runId,
                flags,
                durationMs,
                exitCode,
            });
            process.stderr.write(`${line}\n`);
            const counter = JSON.stringify({
                metric: "smithers_cli_command_total",
                labels: { cmd, exit: String(exitCode) },
                value: 1,
            });
            const histogram = JSON.stringify({
                metric: "smithers_cli_command_duration_ms",
                labels: { cmd },
                value: durationMs,
            });
            process.stderr.write(`${counter}\n`);
            process.stderr.write(`${histogram}\n`);
        }
        catch {
            // Telemetry must not affect command output.
        }
    }
    if (ownsCompletion) {
        if (machineFormat && exitCode !== 0) {
            const parsed = parseCliErrorFromStderr(capturedStderr);
            writeStdoutSync(`${JSON.stringify({
                code: parsed?.code ?? "DEVTOOLS_ERROR",
                message: parsed?.message ?? thrownMessage ?? (capturedStderr.trim() || `smithers ${cmd} exited with code ${exitCode}`),
                ...(parsed?.hint ? { hint: parsed.hint } : {}),
            })}\n`);
        }
        // Exit before incur's streaming path can write its own envelope; the
        // payload already went through the synchronous stdout above.
        process.exit(exitCode);
    }
}

/**
 * Rewrite raw `--json` to `-j` for devtools commands so it lands as a
 * command-scoped boolean option. Without this, Incur's
 * global `--json` flag promotes stdout formatting to JSON and our
 * command option stays false.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function rewriteDevtoolsJsonFlagArgv(argv) {
    const commandIndex = findFirstPositionalIndex(argv);
    if (commandIndex < 0) return argv;
    const cmd = argv[commandIndex];
    if (!DEVTOOLS_COMMANDS.has(cmd)) return argv;
    // Only rewrite tokens after the command positional.
    return argv.map((arg, idx) => (idx > commandIndex && arg === "--json" ? "-j" : arg));
}

/** @param {string[]} argv */
function validateDevtoolsArgv(argv) {
    const commandIndex = findFirstPositionalIndex(argv);
    if (commandIndex < 0) return { handled: false };
    const cmd = argv[commandIndex];
    if (!DEVTOOLS_COMMANDS.has(cmd)) return { handled: false };
    // If `--help` is present, let incur render help (no error).
    if (argv.includes("--help") || argv.includes("-h")) return { handled: false };
    const rest = argv.slice(commandIndex + 1);
    const positionals = [];
    const flags = new Map();
    for (let idx = 0; idx < rest.length; idx++) {
        const token = rest[idx];
        if (!token.startsWith("-")) {
            positionals.push(token);
            continue;
        }
        let key = token;
        /** @type {string | undefined} */
        let value;
        const eq = token.indexOf("=");
        if (token.startsWith("--") && eq !== -1) {
            key = token.slice(0, eq);
            value = token.slice(eq + 1);
        }
        else if (token.startsWith("--") && idx + 1 < rest.length && !rest[idx + 1].startsWith("-")) {
            value = rest[idx + 1];
        }
        flags.set(key, value);
    }
    const required = cmd === "diff" || cmd === "output" ? 2 : 1;
    const usage = devtoolsUsage(cmd);
    if (positionals.length < required) {
        writeStderrSync(`error: missing required argument${required - positionals.length === 1 ? "" : "s"} for \`smithers ${cmd}\`\n`);
        writeStderrSync(`${usage}\n`);
        process.exit(1);
    }
    // Validate --color enum.
    if ((cmd === "tree" || cmd === "diff") && flags.has("--color")) {
        const val = flags.get("--color");
        if (val !== "auto" && val !== "always" && val !== "never") {
            writeStderrSync(`error: invalid value for --color: ${val ?? "(missing)"}\n`);
            writeStderrSync(`expected one of: auto, always, never\n`);
            writeStderrSync(`${usage}\n`);
            process.exit(1);
        }
    }
    // Validate non-negative-integer flags.
    const intFlags = cmd === "tree"
        ? ["--frame", "--depth"]
        : (cmd === "diff" || cmd === "output"
            ? ["--iteration"]
            : []);
    for (const flag of intFlags) {
        if (!flags.has(flag)) continue;
        const raw = flags.get(flag);
        const num = Number(raw);
        if (!Number.isInteger(num) || num < 0) {
            writeStderrSync(`error: invalid value for ${flag}: ${raw ?? "(missing)"}\n`);
            writeStderrSync(`${flag} must be a non-negative integer\n`);
            writeStderrSync(`${usage}\n`);
            process.exit(1);
        }
    }
    if (cmd === "rewind" && positionals.length >= 2) {
        const frameRaw = positionals[1];
        const num = Number(frameRaw);
        if (!Number.isInteger(num) || num < 0) {
            writeStderrSync(`error: invalid value for <frameNo>: ${frameRaw}\n`);
            writeStderrSync(`frameNo must be a non-negative integer\n`);
            writeStderrSync(`${usage}\n`);
            process.exit(1);
        }
    }
    return { handled: false };
}

/** @param {string} cmd */
function devtoolsUsage(cmd) {
    if (cmd === "tree") {
        return [
            "usage: smithers tree <runId> [options]",
            "",
            "Options:",
            "  --frame <n>       Historical frame number",
            "  --watch           Stream live devtools events",
            "  --json            Emit the raw snapshot JSON",
            "  --depth <n>       Truncate rendering at depth n",
            "  --node <id>       Scope output to a subtree",
            "  --color <mode>    auto | always | never",
        ].join("\n");
    }
    if (cmd === "diff") {
        return [
            "usage: smithers diff <runId> <nodeId> [options]",
            "",
            "Options:",
            "  --iteration <n>   Loop iteration (default: latest)",
            "  --json            Emit the raw DiffBundle as JSON",
            "  --stat            Show a stat summary only",
            "  --color <mode>    auto | always | never",
        ].join("\n");
    }
    if (cmd === "output") {
        return [
            "usage: smithers output <runId> <nodeId> [options]",
            "",
            "Options:",
            "  --iteration <n>   Loop iteration (default: latest)",
            "  --json            Emit the raw row as JSON (default)",
            "  --pretty          Schema-ordered render",
        ].join("\n");
    }
    if (cmd === "rewind") {
        return [
            "usage: smithers rewind <runId> <frameNo> [options]",
            "",
            "Options:",
            "  --yes             Skip confirmation prompt",
            "  --json            Emit JumpResult as JSON",
        ].join("\n");
    }
    return `usage: smithers ${cmd} ...`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
/**
 * Resolve the target to persist on a live-run hijack request. `--target`
 * accepts an agent engine or a node id, but the engine-side hand-off check
 * (maybeCompleteHijack in packages/engine) only compares the persisted target
 * against the ENGINE name -- a node id would make the engine skip the hand-off
 * until the CLI times out. When the target matches a node in the run, return
 * that node's recorded agent engine (or null when the node has not recorded
 * one yet -- a null target lets the engine hand off while the CLI still
 * filters candidates by node id afterwards). A target matching no node is
 * treated as an engine name and passed through. (#23)
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string | undefined} target
 * @returns {Promise<string | null>}
 */
async function resolveHijackRequestEngine(adapter, runId, target) {
    if (!target) return null;
    try {
        const attempts = await adapter.listAttemptsForRun(runId);
        const nodeAttempts = attempts
            .filter((attempt) => attempt.nodeId === target)
            .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
        for (const attempt of nodeAttempts) {
            try {
                const meta = JSON.parse(attempt.metaJson ?? "null");
                const engine = meta && typeof meta === "object" && typeof meta.agentEngine === "string"
                    ? meta.agentEngine
                    : null;
                if (engine) return engine;
            }
            catch {
                // Unparseable attempt meta; keep scanning older attempts.
            }
        }
        let isNode = nodeAttempts.length > 0;
        if (!isNode) {
            const nodes = await adapter.listNodes(runId);
            isNode = nodes.some((node) => node.nodeId === target);
        }
        return isNode ? null : target;
    }
    catch {
        return target;
    }
}
// ---------------------------------------------------------------------------
let commandExitOverride;
/**
 * Per-command failure helper: records the handler's requested exit code for
 * main() to apply (instead of incur's generic 1 → 4 mapping), then returns the
 * command's error envelope.
 *
 * @param {{ error: (opts: any) => any }} c
 */
function makeFail(c) {
    return (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
    };
}
// Shared with the init-time incur skill re-sync (SyncSkills.sync uses it as the
// top-level group description, mirroring what `smithers skills add` passes).
const CLI_DESCRIPTION = "Durable AI workflow orchestrator. Run, monitor, and manage workflow executions. " +
    "--json is accepted on every command as shorthand for `--format json`; after events, timeline, tree, diff, output, rewind, snapshots, and restore it is command-scoped and emits that command's raw JSON payload instead.";
const cli = Cli.create({
    name: "smithers",
    // The trailing --json note belongs in the Global Options block, but that
    // list is hardcoded in the incur framework (Help.ts globalOptionsLines), so
    // the alias is documented here until an upstream flag entry lands. (#11)
    description: CLI_DESCRIPTION,
    version: readPackageVersion(),
    mcp: { command: "bunx smithers-orchestrator --mcp" },
})
    // =========================================================================
    // smithers init [prompt]
    // =========================================================================
    .command("init", {
    description: "Install the local Smithers workflow pack into .smithers/. Pass an optional prompt to also launch the create-workflow builder after init.",
    args: initArgs,
    options: initOptions,
    // The interactive run narrates its own progress + next steps; suppress the
    // raw result dump in a human TTY while keeping full JSON for piped/agent use.
    outputPolicy: "agent-only",
    async run(c) {
        const fail = makeFail(c);
        if (c.args.prompt) {
            // Install the pack first (idempotent when already present), then
            // launch the create-workflow builder with the prompt pre-filled.
            let initFailed = false;
            const initFail = (opts) => {
                initFailed = true;
                return fail(opts);
            };
            const initResult = await runInitCommand(c, initFail);
            if (initFailed) return initResult;
            try {
                const workflow = resolveWorkflow("create-workflow", process.cwd());
                return executeUpCommand(c, workflow.entryFile, normalizeWorkflowRunOptions({
                    ...upOptions.parse({}),
                    prompt: c.args.prompt,
                }), fail);
            }
            catch (err) {
                if (err instanceof SmithersError) {
                    // A prompt needs the create-workflow builder; the generic
                    // "Workflow not found" is unhelpful here (and re-running plain
                    // init could keep it deselected). Point at the real fix.
                    const message = err.code === "RUN_NOT_FOUND"
                        ? "create-workflow is not installed in this pack, so `smithers init \"<task>\"` cannot launch the builder. Re-run `smithers init` and keep the create-workflow workflow selected (or run `smithers init` without --agents-only)."
                        : err.message;
                    return fail({ code: err.code, message, exitCode: 4 });
                }
                return fail({ code: "CREATE_WORKFLOW_FAILED", message: err?.message ?? String(err), exitCode: 1 });
            }
        }
        return runInitCommand(c, fail);
    },
})
    .command("add", {
    description: "Install a workflow pack from GitHub, npm, or a local file.",
    aliases: ["install"],
    args: packSpecArgs,
    options: packOptions,
    alias: { global: "g" },
    async run(c) {
        try {
            const durable = await runDurableAdd({ spec: c.args.spec, global: c.options.global, yes: c.options.yes });
            if (durable) return c.ok(durable);
            return c.ok(await addPack(c.args.spec, { from: process.cwd(), global: c.options.global, yes: c.options.yes }));
        }
        catch (error) { return c.error({ code: "PACK_ADD_FAILED", message: error?.message ?? String(error) }); }
    },
})
    .command("remove", {
    description: "Remove an installed workflow pack.",
    args: packNameArgs,
    options: z.object({ global: z.boolean().default(false).describe("Remove from ~/.smithers/packs") }),
    alias: { global: "g" },
    run(c) {
        try { return c.ok(removePack(c.args.name, { from: process.cwd(), global: c.options.global })); }
        catch (error) { return c.error({ code: "PACK_REMOVE_FAILED", message: error?.message ?? String(error) }); }
    },
})
    .command("eject", {
    description: "Copy a pack workflow and its UI, prompts, and libraries into the local .smithers pack.",
    args: packWorkflowArgs,
    run(c) {
        try { return c.ok(ejectPack(c.args.spec, { from: process.cwd() })); }
        catch (error) { return c.error({ code: "PACK_EJECT_FAILED", message: error?.message ?? String(error) }); }
    },
})
    .command("share", {
    description: "Add this project's workflow pack to awesome-smithers and open a pull request.",
    options: z.object({
        repo: z.string().optional().describe("Override the awesome-smithers repository (owner/name)"),
        dryRun: z.boolean().default(false).describe("Print the registry entry and diff without pushing"),
    }),
    alias: { dryRun: "n" },
    run(c) {
        try {
            // Tests exercise the public dry-run path against a real Packs
            // section by pointing this env var at a README fixture.
            const readmeOverride = process.env.SMITHERS_SHARE_REGISTRY_README;
            const registryReadme = readmeOverride ? readFileSync(readmeOverride, "utf8") : undefined;
            return c.ok(sharePack({ from: process.cwd(), repo: c.options.repo, dryRun: c.options.dryRun, registryReadme }));
        }
        catch (error) { return c.error({ code: "PACK_SHARE_FAILED", message: error?.message ?? String(error) }); }
    },
})
    .command("packs", Cli.create({
    name: "packs",
    description: "List and update installed workflow packs.",
}).command("list", {
    description: "List local and global workflow packs.",
    run(c) { return c.ok({ packs: listPacks(process.cwd()) }); },
}).command("update", {
    description: "Re-resolve installed packs from their locked specs (all packs when no name is given).",
    args: z.object({ name: z.string().optional().describe("Pack name to update (default: every locked pack)") }),
    async run(c) {
        try {
            // The lock is the source of truth: a pack whose directory is
            // missing or damaged is restored from its locked spec, not skipped.
            const locked = listLockedPacks(process.cwd()).filter((pack) => !c.args.name || pack.name === c.args.name);
            if (locked.length === 0) {
                return c.error({ code: "PACK_NOT_FOUND", message: c.args.name ? `No lock entry for pack: ${c.args.name}` : "No packs installed" });
            }
            const results = [];
            for (const pack of locked) results.push(await updatePack(pack.name, { from: process.cwd(), global: pack.scope === "global" }));
            return c.ok({ updated: results });
        }
        catch (error) { return c.error({ code: "PACK_UPDATE_FAILED", message: error?.message ?? String(error) }); }
    },
}))
    // =========================================================================
    // smithers make-workflow [task]
    // =========================================================================
    .command("make-workflow", {
    description: "Build a new Smithers workflow from a plain-English description. Dispatches to the create-workflow builder. Run `smithers init` first if the .smithers/ pack is not yet installed.",
    args: z.object({
        task: z.string().optional().describe("Plain-English description of the workflow to build (forwarded as the builder prompt)"),
    }),
    options: workflowRunOptions,
    alias: { detach: "d", runId: "r", input: "i", maxConcurrency: "c", prompt: "p" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const workflow = resolveWorkflow("create-workflow", process.cwd());
            if (c.options.interactive) {
                if (!Boolean(process.stdin.isTTY && process.stdout.isTTY)) {
                    return fail({ code: "INTERACTIVE_REQUIRES_TTY", message: "--interactive needs an interactive terminal (TTY).", exitCode: 4 });
                }
                // Thread the positional task through as the builder's --prompt so
                // the interactive prompts pre-fill it (a bare Enter keeps it)
                // instead of silently dropping the typed description. Shallow-copy
                // the context so the shared c.options is never mutated.
                const interactiveContext = {
                    ...c,
                    options: { ...c.options, prompt: c.args.task ?? c.options.prompt },
                };
                return runTuiCommand(interactiveContext, fail, { preselect: workflow });
            }
            const prompt = c.args.task ?? c.options.prompt;
            return executeUpCommand(c, workflow.entryFile, normalizeWorkflowRunOptions({ ...c.options, prompt }), fail);
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({
                    code: err.code,
                    message: err.code === "RUN_NOT_FOUND"
                        ? `${err.message} — run \`smithers init\` first to install the workflow pack`
                        : err.message,
                    exitCode: 4,
                });
            }
            return fail({ code: "MAKE_WORKFLOW_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers starters [id]
    // =========================================================================
    .command("starters", {
    description: "Show plain-English starter workflows with copy-paste commands.",
    args: startersArgs,
    options: startersOptions,
    run(c) {
        const fail = makeFail(c);
        return runStartersCommand(c, fail);
    },
})
    // =========================================================================
    // smithers hermes
    // =========================================================================
    .command("hermes", {
    description: "Add Smithers to a local Hermes agent: register the MCP server and install the native Hermes plugin (slash commands, live status line, approval buttons). Alias for `mcp add --agent hermes`.",
    run(c) {
        const results = wireExtraAgents({ kind: "mcp", agents: ["hermes"] });
        if (results.every((r) => r.reason === "not-detected")) {
            console.error("Hermes was not found (no ~/.hermes directory on this machine).");
            console.error("Install Hermes first, then re-run: https://github.com/NousResearch/hermes-agent");
            return c.ok({ installed: false });
        }
        for (const r of results) {
            if (r.registered) console.error(`✓ ${r.agent} MCP server: ${r.path}`);
            else if (r.installedPlugin) console.error(`✓ ${r.agent} plugin: ${r.path}${r.enabled ? " (enabled)" : ""}`);
            else if (r.reason && r.reason !== "not-detected") console.error(`⚠ ${r.agent}: skipped (${r.reason})`);
        }
        console.error("");
        console.error("Smithers is ready in Hermes. From the Hermes CLI or any chat, try: /smithers ps");
        const mcp = results.find((r) => r.registered);
        const plugin = results.find((r) => r.installedPlugin);
        return c.ok({ installed: true, mcpServer: mcp?.path, plugin: plugin?.path, enabled: Boolean(plugin?.enabled) });
    },
})
    // =========================================================================
    // smithers up [workflow]
    // =========================================================================
    .command("up", {
    description: "Start a workflow execution. Omit the workflow (or pass --interactive) to pick one interactively and monitor it in the full-screen TUI; use -d for detached (background) mode.",
    args: upArgs,
    options: upRunOptions,
    alias: { detach: "d", runId: "r", input: "i", maxConcurrency: "c" },
    async run(c) {
        const fail = makeFail(c);
        const mode = interactiveLaunchMode(c.options, Boolean(c.args.workflow), c.format);
        if (mode === "needs-tty") {
            return fail({ code: "INTERACTIVE_REQUIRES_TTY", message: "--interactive needs an interactive terminal (TTY) and human output; it cannot be combined with --format json/jsonl.", exitCode: 4 });
        }
        if (mode === "missing-arg") {
            return fail({ code: "WORKFLOW_REQUIRED", message: "Provide a workflow file path, or pass --interactive to pick one.", exitCode: 4 });
        }
        if (mode === "interactive") {
            let preselect;
            if (c.args.workflow) {
                const asPath = resolve(process.cwd(), c.args.workflow);
                if (existsSync(asPath)) {
                    const id = basename(c.args.workflow).replace(/\.[mc]?[tj]sx?$/i, "");
                    preselect = { entryFile: asPath, id, displayName: id };
                }
                else {
                    // Not a file — treat the arg as a discovered workflow ID, the
                    // same way `smithers workflow run <id>` does.
                    try {
                        const discovered = resolveWorkflow(c.args.workflow, process.cwd());
                        preselect = { entryFile: discovered.entryFile, id: discovered.id, displayName: discovered.displayName ?? discovered.id };
                    }
                    catch (err) {
                        if (err instanceof SmithersError) {
                            return fail({ code: err.code, message: err.message, exitCode: 4 });
                        }
                        throw err;
                    }
                }
            }
            return runTuiCommand(c, fail, { preselect });
        }
        const optionError = validateUpOptionConsistency(c.options);
        if (optionError)
            return fail(optionError);
        return executeUpCommand(c, c.args.workflow, c.options, fail);
    },
})
    // =========================================================================
    // smithers migrate
    // =========================================================================
    .command("migrate", {
    description: "Copy the legacy bun:sqlite smithers.db into PGlite or Postgres and write the migrated.json marker.",
    options: migrateOptions,
    async run(c) {
        const fail = makeFail(c);
        try {
            const { migrateSmithersStore } = await import("smithers-orchestrator/migrateSmithersStore");
            if (!c.options.to) {
                return fail({
                    code: "INVALID_INPUT",
                    message: "smithers migrate requires --to. Choose one of: pglite, postgres, sqlite.",
                    exitCode: 4,
                });
            }
            if (c.options.agent) {
                const redactedUrl = redactConnectionStringForCli(c.options.url);
                return fail({
                    code: "MIGRATION_AGENT_REQUIRED",
                    message: `Deterministic migration repair guidance is available from smithers migrate errors. Agent-assisted migration repair is tracked as a follow-up and is not available in this build; no migrate-repair workflow is installed. Run deterministic migration with:\n  smithers migrate --from ${c.options.from ?? "<source>"} --to ${c.options.to}${redactedUrl ? ` --url ${redactedUrl}` : ""}`,
                    exitCode: 4,
                });
            }
            const result = await migrateSmithersStore({
                cwd: process.cwd(),
                from: c.options.from,
                to: c.options.to,
                url: c.options.url,
                keepSqlite: c.options.keepSqlite,
                onProgress(event) {
                    if (event.type === "table-copied") {
                        process.stderr.write(`[smithers] migrated ${event.table}: ${event.targetRows}/${event.sourceRows} rows\n`);
                    }
                    else if (event.type === "done") {
                        process.stderr.write(`[smithers] migration completed in ${event.durationMs}ms\n`);
                    }
                },
            });
            // Migrating the store is a natural "I'm bringing this setup current"
            // moment — force-refresh the curated agent skill while we're here.
            const refreshNotice = formatRefreshNotice(ensureCuratedSkillsFresh({ force: true }));
            if (refreshNotice) process.stderr.write(`${refreshNotice}\n`);
            return c.ok(result, {
                cta: {
                    description: "Next steps:",
                    commands: [
                        { command: "smithers gateway", description: "Start the Gateway on the migrated backend" },
                        { command: "smithers <cmd> --backend sqlite", description: "Temporarily use the old SQLite store" },
                    ],
                },
            });
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: 4 });
            }
            return fail({ code: "MIGRATION_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers bug
    // =========================================================================
    .command("bug", {
    description: "File a smithers bug report to bug.smithers.sh; with --run it attaches the run's status, error, and last ~50 events (secrets scrubbed).",
    options: bugOptions,
    // The command narrates its own "Filed bug ..." line on stderr; suppress the
    // raw result dump in a human TTY while keeping full structured output for
    // piped/agent use.
    outputPolicy: "agent-only",
    async run(c) {
        const fail = makeFail(c);
        return runBugCommand(c, fail);
    },
})
    // =========================================================================
    // smithers review [repo]
    // =========================================================================
    .command("review", {
    description: "Run code review plus story-form HTML walkthrough generation for a repo or PR.",
    async run(c) {
        // Real CLI execution is handled by the raw-argv intercept in main() so
        // the review CLI sees the actual flags; this registration exists so the
        // command shows up in `smithers --help`. It is only ever reached through
        // a non-CLI transport (the raw/both MCP tool surface, or HTTP), where
        // reading process.argv and process.exit()-ing the long-lived review CLI
        // would crash the host. Return a graceful error instead.
        return c.error({
            code: "MCP_UNSUPPORTED",
            message: "`smithers review` runs a long-lived review workflow and is only available from a shell, not as an MCP/HTTP tool. Run `smithers review [repo] [options]` in a terminal.",
        });
    },
})
    // =========================================================================
    // smithers gateway
    // =========================================================================
    .command("gateway", {
    description: "Serve the multi-run Gateway RPC/WS control plane for workspace run state; unlike up --serve, this is not tied to one run. `smithers gateway status|stop` manages the workspace's running singleton.",
    args: gatewayArgs,
    options: gatewayOptions,
    alias: { host: "H", port: "p" },
    async run(c) {
        const fail = makeFail(c);
        try {
            if (c.args.action === "status") {
                return await runGatewayStatusCommand(c);
            }
            if (c.args.action === "stop") {
                return await runGatewayStopCommand(c);
            }
            await runGatewayCommand(c.options);
            // The Gateway is a long-running server: by the time runGatewayCommand
            // resolves it has already been shut down (SIGINT/SIGTERM) and written
            // its full status to stderr. Exit cleanly instead of emitting a
            // completion descriptor — a server must keep stdout clean so callers
            // can pipe/consume it without a trailing result frame.
            process.exit(0);
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: 4 });
            }
            return fail({ code: "GATEWAY_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers eval <workflow>
    // =========================================================================
    .command("eval", {
    description: "Run a workflow over a JSON/JSONL eval suite and write a regression report.",
    args: workflowArgs,
    options: evalOptions,
    alias: { cases: "c", suite: "s", dryRun: "n", concurrency: "j", report: "r" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const workflowPath = resolveWorkflowArg(c.args.workflow);
            const loadedCases = loadEvalCases(process.cwd(), c.options.cases, {
                maxCases: c.options.maxCases,
            });
            const plan = buildEvalPlan({
                suiteId: c.options.suite,
                runLabel: c.options.runLabel ?? defaultEvalRunLabel(),
                workflowPath,
                casesPath: c.options.cases,
                loadedCases,
            });
            const wantsStructured = c.format === "json" || c.format === "jsonl" || formatRequestedJsonOutput();
            if (c.options.dryRun) {
                const humanTty = Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
                    (c.format === undefined || c.format === "toon");
                if (wantsStructured || !humanTty) {
                    return c.ok({ suite: plan });
                }
                process.stdout.write(`${renderEvalPlan(plan)}\n`);
                return c.ok(undefined);
            }
            assertEvalReportWritable(process.cwd(), plan.suiteId, {
                path: c.options.report,
                force: c.options.force,
            });
            const workflow = await loadWorkflow(workflowPath);
            ensureSmithersTables(workflow.db);
            await assertEvalRunIdsAvailable(new SmithersDb(workflow.db), plan.cases);
            setupSqliteCleanup(workflow);
            const schema = resolveSchema(workflow.db);
            const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
            const rootDir = resolveLaunchRootDir(c.options.root);
            const logDir = c.options.log ? c.options.logDir : null;
            const abort = setupAbortSignal();
            const judgeRunner = plan.cases.some((testCase) => testCase.judge)
                ? createEvalJudgeRunner({
                    provider: c.options.judgeProvider,
                    model: c.options.judgeModel,
                    cwd: process.cwd(),
                })
                : undefined;
            const startedAtMs = Date.now();
            const results = await withOptimizationArtifactEnv(c.options.optimization, () => runWithLimit(plan.cases, c.options.concurrency, async (testCase) => {
                const caseStartedAtMs = Date.now();
                process.stderr.write(`[eval:${plan.suiteId}] ${testCase.id} -> ${testCase.runId}\n`);
                try {
                    const result = await Effect.runPromise(runWorkflow(workflow, {
                        input: testCase.input,
                        runId: testCase.runId,
                        workflowPath: resolvedWorkflowPath,
                        maxConcurrency: c.options.maxConcurrency,
                        rootDir,
                        logDir,
                        allowNetwork: c.options.allowNetwork,
                        maxOutputBytes: c.options.maxOutputBytes,
                        toolTimeoutMs: c.options.toolTimeoutMs,
                        annotations: {
                            suiteId: plan.suiteId,
                            caseId: testCase.id,
                            ...testCase.annotations,
                        },
                        signal: abort.signal,
                    }));
                    const output = await loadOutputs(workflow.db, schema, testCase.runId);
                    const durationMs = Date.now() - caseStartedAtMs;
                    const evaluation = await evaluateEvalCaseResultAsync(testCase, {
                        ...result,
                        output,
                    }, { runJudge: judgeRunner });
                    return {
                        caseId: testCase.id,
                        runId: testCase.runId,
                        expectedStatus: testCase.expected.status,
                        status: result.status,
                        passed: evaluation.passed,
                        assertions: evaluation.assertions,
                        durationMs,
                        input: testCase.input,
                        ...(c.options.includeOutput ? { output } : {}),
                        metadata: testCase.metadata,
                    };
                }
                catch (err) {
                    const errorMessage = err?.message ?? String(err);
                    const durationMs = Date.now() - caseStartedAtMs;
                    const evaluation = await evaluateEvalCaseResultAsync(testCase, {
                        status: "error",
                        error: err,
                    }, { runJudge: judgeRunner });
                    return {
                        caseId: testCase.id,
                        runId: testCase.runId,
                        expectedStatus: testCase.expected.status,
                        status: "error",
                        passed: evaluation.passed,
                        assertions: evaluation.assertions,
                        durationMs,
                        input: testCase.input,
                        error: errorMessage,
                        metadata: testCase.metadata,
                    };
                }
            }));
            const finishedAtMs = Date.now();
            let report = buildEvalReport({
                plan,
                results,
                startedAtMs,
                finishedAtMs,
            });
            const reportPath = writeEvalReport(process.cwd(), report, {
                path: c.options.report,
                force: c.options.force,
            });
            report = { ...report, reportPath };
            process.exitCode = report.summary.failed > 0 ? 1 : 0;
            // Only a human on a TTY gets the formatted `renderEvalReport` text.
            // A piped/agent consumer (non-TTY, default TOON) must get a single
            // coherent TOON envelope, NOT the human report followed by a stray
            // `c.ok(undefined)` tail (which renders as `data: null` plus the
            // auto-injected skills CTA — two output formats under one command).
            const humanTty = Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
                (c.format === undefined || c.format === "toon");
            if (wantsStructured || !humanTty) {
                return c.ok({ eval: report });
            }
            process.stdout.write(`${renderEvalReport(report)}\n`);
            return c.ok(undefined);
        }
        catch (err) {
            if (err instanceof SmithersError) {
                return fail({ code: err.code, message: err.message, exitCode: 4 });
            }
            return fail({ code: "EVAL_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers optimize <workflow>
    // =========================================================================
    .command("optimize", {
    description: "Run GEPA prompt optimization over a workflow eval suite and write an optimized prompt artifact.",
    args: workflowArgs,
    options: optimizeOptions,
    alias: { cases: "c", suite: "s", provider: "p", model: "m", artifact: "a", concurrency: "j" },
    async run(c) {
        return runOptimizeCommand(c, {
            defaultEvalRunLabel,
            formatRequestedJsonOutput,
            loadWorkflow,
            resolveWorkflowPathForEval: resolveWorkflowArg,
            setupAbortSignal,
            setupSqliteCleanup,
            setCommandExitOverride: (exitCode) => {
                commandExitOverride = exitCode;
            },
        });
    },
})
    // =========================================================================
    // smithers supervise
    // =========================================================================
    .command("supervise", {
    description: "Watch explicitly named stale runs and auto-resume them; pass --all to opt into a workspace-wide sweep.",
    options: superviseOptions,
    alias: { run: "r", all: "a", dryRun: "n", interval: "i", staleThreshold: "t", maxConcurrent: "c" },
    async run(c) {
        const fail = makeFail(c);
        const runIds = c.options.run
            ? [...new Set(c.options.run.split(",").map((runId) => runId.trim()).filter(Boolean))]
            : [];
        if (runIds.length === 0 && !c.options.all) {
            return fail({ code: "SUPERVISOR_SCOPE_REQUIRED", message: "Refusing a workspace-wide sweep without an explicit scope. Pass --run <id>[,<id>...] or --all.", exitCode: 4 });
        }
        if (runIds.length > 0 && c.options.all) {
            return fail({ code: "INVALID_SUPERVISOR_SCOPE", message: "Choose either --run <id>[,<id>...] or --all, not both.", exitCode: 4 });
        }
        let parsed;
        try {
            parsed = resolveSupervisorOptions(c.options.interval, c.options.staleThreshold, c.options.maxConcurrent, c.options.dryRun);
        }
        catch (error) {
            return fail({
                code: error instanceof SmithersError
                    ? error.code
                    : "INVALID_SUPERVISOR_OPTIONS",
                message: error?.message ?? String(error),
                exitCode: 4,
            });
        }
        const { adapter, cleanup } = await findAndOpenSupervisorDb(runIds);
        const abort = setupAbortSignal();
        const scope = c.options.all ? "all workspace runs" : runIds.join(",");
        process.stderr.write(`[smithers] Supervisor started (scope=${scope}, interval=${parsed.pollIntervalMs}ms, staleThreshold=${parsed.staleThresholdMs}ms, maxConcurrent=${parsed.maxConcurrent}, dryRun=${parsed.dryRun})\n`);
        try {
            const supervisorOptions = {
                adapter,
                ...(c.options.all ? {} : { runIds }),
                dryRun: parsed.dryRun,
                pollIntervalMs: parsed.pollIntervalMs,
                staleThresholdMs: parsed.staleThresholdMs,
                maxConcurrent: parsed.maxConcurrent,
            };
            if (parsed.dryRun) {
                const summary = await runPromise(supervisorPollEffect(supervisorOptions));
                return c.ok({ status: "dry-run", scope: c.options.all ? "all" : runIds, wouldResume: summary.wouldResumeRunIds, ...summary });
            }
            await runPromise(supervisorLoopEffect(supervisorOptions), { signal: abort.signal });
            return c.ok({ status: "stopped" });
        }
        catch (error) {
            if (abort.signal.aborted) {
                return c.ok({ status: "stopped" });
            }
            return fail({
                code: "SUPERVISOR_FAILED",
                message: error?.message ?? String(error),
                exitCode: 1,
            });
        }
        finally {
            cleanup();
        }
    },
})
    // =========================================================================
    // smithers ps
    // =========================================================================
    .command("ps", {
    description: "List active, paused, and recently completed runs.",
    options: psOptions,
    alias: { status: "s", limit: "l", all: "a", watch: "w", interval: "i" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                if (c.options.watch) {
                    const intervalMs = resolveWatchIntervalMsOrFail("ps", c.options.interval, fail);
                    const watchResult = await runPromise(Effect.tryPromise(() => runWatchLoop({
                        intervalSeconds: c.options.interval,
                        clearScreen: true,
                        fetch: async () => ({
                            runs: await buildPsRows(adapter, c.options.limit, c.options.status),
                        }),
                        render: async (snapshot) => {
                            writeWatchOutput(c.format, snapshot);
                        },
                    })).pipe(Effect.tap((result) => Effect.logDebug("watch loop completed").pipe(Effect.annotateLogs({
                        command: "ps",
                        intervalMs,
                        tickCount: result.tickCount,
                        stoppedBySignal: result.stoppedBySignal,
                    }))), Effect.annotateLogs({ command: "ps", intervalMs }), Effect.withLogSpan("cli:watch")));
                    if (watchResult.stoppedBySignal) {
                        process.exitCode = 0;
                    }
                    return c.ok(undefined);
                }
                const rows = await buildPsRows(adapter, c.options.limit, c.options.status);
                const ctaCommands = buildPsCtaCommands(rows);
                return c.ok({ runs: rows }, rows.length > 0
                    ? {
                        cta: withAgentNextSteps({
                            runId: rows[0].id,
                            workflowId: rows[0].workflowId,
                        }, ctaCommands),
                    }
                    : (ctaCommands.length > 0 ? { cta: { commands: ctaCommands } } : undefined));
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            // A never-initialized workspace simply has zero runs. Treat the
            // benign "no store exists yet" case (CLI_DB_NOT_FOUND, raised by
            // openSmithersStore when no smithers.db / store has been created)
            // as an empty run list with exit 0, matching the pluggable-DB
            // contract. A genuinely corrupt/locked/unreadable store surfaces a
            // different error code and still fails as PS_FAILED below.
            if (err instanceof SmithersError && err.code === "CLI_DB_NOT_FOUND") {
                return c.ok({ runs: [] });
            }
            return fail({ code: "PS_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers logs <run_id>
    // =========================================================================
    .command("logs", {
    description: "Tail the event log of a specific run.",
    args: z.object({ runId: z.string().describe("Run ID to tail") }),
    options: logsOptions,
    alias: { follow: "f", tail: "n" },
    async *run(c) {
        return yield* streamRunEventsCommand(c);
    },
})
    // =========================================================================
    // smithers events <run_id>
    // =========================================================================
    .command("events", {
    description: "Query node/run lifecycle history by default; pass --raw for raw agent chunks and all event types.",
    args: z.object({ runId: z.string().describe("Run ID to query") }),
    options: eventsOptions,
    alias: { node: "n", type: "t", since: "s", limit: "l", json: "j", watch: "w", interval: "i" },
    async *run(c) {
        const fail = makeFail(c);
        let query;
        try {
            query = normalizeEventsQuery(c.options);
        }
        catch (error) {
            return fail({
                code: error instanceof SmithersError ? error.code : "INVALID_EVENTS_OPTIONS",
                message: error?.message ?? String(error),
                exitCode: 4,
            });
        }
        let cleanup;
        try {
            const db = await findAndOpenDb();
            const adapter = db.adapter;
            cleanup = db.cleanup;
            const run = await adapter.getRun(c.args.runId);
            if (!run) {
                return fail({
                    code: "RUN_NOT_FOUND",
                    message: `Run not found: ${c.args.runId}`,
                    exitCode: 4,
                });
            }
            if (query.limitCapped) {
                process.stderr.write(`[smithers] --limit capped at ${MAX_EVENTS_LIMIT} events\n`);
            }
            let groupBy = query.groupBy;
            if (query.json && groupBy) {
                process.stderr.write("[smithers] --group-by is ignored when --json is enabled\n");
                groupBy = undefined;
            }
            if (c.options.watch && groupBy) {
                process.stderr.write("[smithers] --group-by is ignored when --watch is enabled\n");
                groupBy = undefined;
            }
            let watchIntervalMs;
            if (c.options.watch) {
                watchIntervalMs = resolveWatchIntervalMsOrFail("events", c.options.interval, fail);
            }
            const filters = {
                nodeId: query.nodeId,
                type: query.typeName,
                sinceTimestampMs: query.sinceTimestampMs,
                limit: query.limit,
                json: query.json,
                groupBy,
                watch: c.options.watch,
            };
            const baseMs = run.startedAtMs ??
                run.createdAtMs ??
                Date.now();
            const totalCount = query.defaultLimitUsed && !query.json
                ? await countEventHistory(adapter, c.args.runId, {
                    nodeId: query.nodeId,
                    eventTypes: query.eventTypes,
                    sinceTimestampMs: query.sinceTimestampMs,
                })
                : undefined;
            const groupedEvents = [];
            let emitted = 0;
            let lastSeq = -1;
            while (emitted < query.limit) {
                const pageLimit = Math.min(EVENTS_PAGE_SIZE, query.limit - emitted);
                const page = await queryEventHistoryPage(adapter, c.args.runId, {
                    afterSeq: lastSeq,
                    nodeId: query.nodeId,
                    eventTypes: query.eventTypes,
                    sinceTimestampMs: query.sinceTimestampMs,
                    limit: pageLimit,
                });
                if (page.length === 0)
                    break;
                for (const event of page) {
                    lastSeq = event.seq;
                    emitted += 1;
                    if (groupBy) {
                        groupedEvents.push(event);
                    }
                    else {
                        if (query.json) {
                            process.stdout.write(`${buildEventNdjsonLine(event)}\n`);
                        }
                        else {
                            yield buildEventHistoryLine(event, baseMs);
                        }
                    }
                    if (emitted >= query.limit)
                        break;
                }
                if (page.length < pageLimit)
                    break;
            }
            if (groupBy) {
                const groupedLines = renderGroupedEvents(groupedEvents, baseMs, groupBy);
                for (const line of groupedLines) {
                    yield line;
                }
            }
            if (query.defaultLimitUsed &&
                !query.json &&
                typeof totalCount === "number" &&
                totalCount > query.limit) {
                yield `showing first ${query.limit} of ${totalCount} events, use --limit to see more`;
            }
            if (c.options.watch && !isRunStatusTerminal(run.status)) {
                /**
       * @param {EventHistoryRow[]} events
       */
                const renderEvents = (events) => {
                    for (const event of events) {
                        lastSeq = Math.max(lastSeq, event.seq);
                        emitted += 1;
                        if (query.json) {
                            process.stdout.write(`${buildEventNdjsonLine(event)}\n`);
                        }
                        else {
                            process.stdout.write(`${buildEventHistoryLine(event, baseMs)}\n`);
                        }
                    }
                };
                const watchResult = await runPromise(Effect.tryPromise(() => runWatchLoop({
                    intervalSeconds: c.options.interval,
                    clearScreen: false,
                    fetch: async () => ({
                        events: await queryEventHistoryPage(adapter, c.args.runId, {
                            afterSeq: lastSeq,
                            nodeId: query.nodeId,
                            eventTypes: query.eventTypes,
                            sinceTimestampMs: query.sinceTimestampMs,
                            limit: EVENTS_PAGE_SIZE,
                        }),
                        status: (await adapter.getRun(c.args.runId))?.status,
                    }),
                    render: async (snapshot) => {
                        renderEvents(snapshot.events);
                    },
                    isTerminal: (snapshot) => isRunStatusTerminal(snapshot.status),
                })).pipe(Effect.tap((result) => Effect.logDebug("watch loop completed").pipe(Effect.annotateLogs({
                    command: "events",
                    intervalMs: watchIntervalMs,
                    tickCount: result.tickCount,
                    stoppedBySignal: result.stoppedBySignal,
                }))), Effect.annotateLogs({
                    command: "events",
                    runId: c.args.runId,
                    intervalMs: watchIntervalMs,
                }), Effect.withLogSpan("cli:watch")));
                if (watchResult.reachedTerminal) {
                    while (true) {
                        const finalPage = await queryEventHistoryPage(adapter, c.args.runId, {
                            afterSeq: lastSeq,
                            nodeId: query.nodeId,
                            eventTypes: query.eventTypes,
                            sinceTimestampMs: query.sinceTimestampMs,
                            limit: EVENTS_PAGE_SIZE,
                        });
                        if (finalPage.length === 0)
                            break;
                        renderEvents(finalPage);
                        if (finalPage.length < EVENTS_PAGE_SIZE)
                            break;
                    }
                }
                if (watchResult.stoppedBySignal) {
                    process.exitCode = 0;
                }
            }
            await runPromise(Effect.succeed(undefined).pipe(Effect.annotateLogs({
                runId: c.args.runId,
                filters,
                resultCount: emitted,
            }), Effect.withLogSpan("cli:events")));
            if (query.json)
                return;
            return c.ok(undefined);
        }
        finally {
            cleanup?.();
        }
    },
})
    // =========================================================================
    // smithers chat [run_id]
    // =========================================================================
    .command("chat", {
    description: "Show agent chat output for the latest run or a specific run.",
    args: chatArgs,
    options: chatOptions,
    alias: { follow: "f", tail: "n", all: "a" },
    async *run(c) {
        let cleanup;
        try {
            const db = await findAndOpenDb();
            const adapter = db.adapter;
            cleanup = db.cleanup;
            let run;
            if (c.args.runId) {
                run = await adapter.getRun(c.args.runId);
            }
            else {
                const latestRuns = await adapter.listRuns(1);
                run = latestRuns[0];
            }
            if (!run) {
                yield c.args.runId
                    ? `Error: Run not found: ${c.args.runId}`
                    : "Error: No runs found.";
                return;
            }
            const runId = run.runId;
            const baseMs = run.startedAtMs ?? run.createdAtMs ?? Date.now();
            const printedHeaders = new Set();
            const emittedBlockIds = new Set();
            const stdoutSeenAttempts = new Set();
            const selectedAttemptKeys = new Set();
            const attemptByKey = new Map();
            const knownOutputAttemptKeys = new Set();
            /**
     * @param {Array<{ attemptKey: string; blockId: string; timestampMs: number; text: string }>} blocks
     */
            const renderLines = (blocks) => {
                const lines = [];
                for (const block of blocks) {
                    if (emittedBlockIds.has(block.blockId))
                        continue;
                    emittedBlockIds.add(block.blockId);
                    const attempt = attemptByKey.get(block.attemptKey);
                    if (!attempt)
                        continue;
                    if (!printedHeaders.has(block.attemptKey)) {
                        if (lines.length > 0)
                            lines.push("");
                        lines.push(formatChatAttemptHeader(attempt));
                        printedHeaders.add(block.attemptKey);
                    }
                    lines.push(block.text);
                }
                return lines;
            };
            /**
     * @param {any} attempt
     */
            const buildPromptBlock = (attempt) => {
                const attemptKey = chatAttemptKey(attempt);
                const meta = parseChatAttemptMeta(attempt.metaJson);
                const prompt = typeof meta.prompt === "string" ? meta.prompt.trim() : "";
                if (!prompt)
                    return null;
                return {
                    attemptKey,
                    blockId: `prompt:${attemptKey}`,
                    timestampMs: attempt.startedAtMs ?? baseMs,
                    text: formatChatBlock({
                        baseMs,
                        timestampMs: attempt.startedAtMs ?? baseMs,
                        role: "user",
                        attempt,
                        text: prompt,
                    }),
                };
            };
            /**
     * @param {ReturnType<typeof parseNodeOutputEvent>} event
     */
            const buildOutputBlock = (event) => {
                if (!event)
                    return null;
                const attemptKey = chatAttemptKey(event);
                if (!selectedAttemptKeys.has(attemptKey))
                    return null;
                if (event.stream === "stderr" && !c.options.stderr)
                    return null;
                if (event.stream === "stdout") {
                    stdoutSeenAttempts.add(attemptKey);
                }
                return {
                    attemptKey,
                    blockId: `event:${event.seq}`,
                    timestampMs: event.timestampMs,
                    text: formatChatBlock({
                        baseMs,
                        timestampMs: event.timestampMs,
                        role: event.stream === "stderr" ? "stderr" : "assistant",
                        attempt: event,
                        text: event.text,
                    }),
                };
            };
            /**
     * @param {any} attempt
     */
            const buildFallbackBlock = (attempt) => {
                const attemptKey = chatAttemptKey(attempt);
                const responseText = typeof attempt.responseText === "string"
                    ? attempt.responseText.trim()
                    : "";
                if (!responseText || stdoutSeenAttempts.has(attemptKey))
                    return null;
                return {
                    attemptKey,
                    blockId: `response:${attemptKey}`,
                    timestampMs: attempt.finishedAtMs ?? attempt.startedAtMs ?? baseMs,
                    text: formatChatBlock({
                        baseMs,
                        timestampMs: attempt.finishedAtMs ?? attempt.startedAtMs ?? baseMs,
                        role: "assistant",
                        attempt,
                        text: responseText,
                    }),
                };
            };
            /**
     * @param {any[]} attempts
     */
            const syncAttempts = (attempts) => {
                for (const attempt of attempts) {
                    attemptByKey.set(chatAttemptKey(attempt), attempt);
                }
                const selected = selectChatAttempts(attempts, knownOutputAttemptKeys, c.options.all);
                if (c.options.all || selectedAttemptKeys.size === 0) {
                    for (const attempt of selected) {
                        selectedAttemptKeys.add(chatAttemptKey(attempt));
                    }
                }
                return selected;
            };
            const initialAttempts = await adapter.listAttemptsForRun(runId);
            syncAttempts(initialAttempts);
            const initialEvents = await listAllEvents(adapter, runId);
            const parsedInitialOutputs = initialEvents
                .map((event) => parseNodeOutputEvent(event) ?? parseAgentEvent(event))
                .filter(Boolean);
            for (const event of parsedInitialOutputs) {
                knownOutputAttemptKeys.add(chatAttemptKey(event));
            }
            const selectedInitialAttempts = syncAttempts(initialAttempts);
            const initialBlocks = [];
            for (const attempt of selectedInitialAttempts) {
                const promptBlock = buildPromptBlock(attempt);
                if (promptBlock)
                    initialBlocks.push(promptBlock);
            }
            for (const event of parsedInitialOutputs) {
                const block = buildOutputBlock(event);
                if (block)
                    initialBlocks.push(block);
            }
            for (const attempt of selectedInitialAttempts) {
                const fallbackBlock = buildFallbackBlock(attempt);
                if (fallbackBlock)
                    initialBlocks.push(fallbackBlock);
            }
            initialBlocks.sort((a, b) => {
                if (a.timestampMs !== b.timestampMs)
                    return a.timestampMs - b.timestampMs;
                return a.blockId.localeCompare(b.blockId);
            });
            const visibleInitialBlocks = c.options.tail
                ? initialBlocks.slice(-c.options.tail)
                : initialBlocks;
            const initialLines = renderLines(visibleInitialBlocks);
            for (const line of initialLines) {
                yield line;
            }
            if (selectedAttemptKeys.size === 0 && !c.options.follow) {
                yield `No agent chat logs found for run: ${runId}`;
                return;
            }
            let lastSeq = initialEvents.length > 0
                ? initialEvents[initialEvents.length - 1].seq
                : -1;
            if (!c.options.follow) {
                return c.ok(undefined, {
                    cta: {
                        commands: [
                            { command: `inspect ${runId}`, description: "Inspect run state" },
                            { command: `logs ${runId}`, description: "Tail lifecycle events" },
                        ],
                    },
                });
            }
            while (true) {
                await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_INTERVAL_MS));
                const attempts = await adapter.listAttemptsForRun(runId);
                syncAttempts(attempts);
                const newRows = await adapter.listEvents(runId, lastSeq, 200);
                const newBlocks = [];
                for (const eventRow of newRows) {
                    lastSeq = eventRow.seq;
                    const parsed = parseNodeOutputEvent(eventRow) ?? parseAgentEvent(eventRow);
                    if (!parsed)
                        continue;
                    knownOutputAttemptKeys.add(chatAttemptKey(parsed));
                    if (c.options.all || selectedAttemptKeys.size === 0) {
                        syncAttempts(attempts);
                    }
                    const block = buildOutputBlock(parsed);
                    if (block)
                        newBlocks.push(block);
                }
                for (const attempt of attempts.filter((entry) => selectedAttemptKeys.has(chatAttemptKey(entry)))) {
                    const promptBlock = buildPromptBlock(attempt);
                    if (promptBlock && !emittedBlockIds.has(promptBlock.blockId)) {
                        newBlocks.push(promptBlock);
                    }
                    const fallbackBlock = buildFallbackBlock(attempt);
                    if (fallbackBlock && !emittedBlockIds.has(fallbackBlock.blockId)) {
                        newBlocks.push(fallbackBlock);
                    }
                }
                newBlocks.sort((a, b) => {
                    if (a.timestampMs !== b.timestampMs)
                        return a.timestampMs - b.timestampMs;
                    return a.blockId.localeCompare(b.blockId);
                });
                const newLines = renderLines(newBlocks);
                for (const line of newLines) {
                    yield line;
                }
                const currentRun = await adapter.getRun(runId);
                const currentStatus = currentRun?.status;
                if (currentStatus !== "running" &&
                    currentStatus !== "waiting-approval" &&
                    currentStatus !== "waiting-event" &&
                    currentStatus !== "waiting-timer") {
                    const finalAttempts = await adapter.listAttemptsForRun(runId);
                    syncAttempts(finalAttempts);
                    const finalBlocks = finalAttempts
                        .filter((attempt) => selectedAttemptKeys.has(chatAttemptKey(attempt)))
                        .map((attempt) => buildFallbackBlock(attempt))
                        .filter(Boolean);
                    const finalLines = renderLines(finalBlocks);
                    for (const line of finalLines) {
                        yield line;
                    }
                    return c.ok(undefined, {
                        cta: {
                            commands: [
                                { command: `inspect ${runId}`, description: "Inspect run state" },
                                { command: `logs ${runId}`, description: "Tail lifecycle events" },
                            ],
                        },
                    });
                }
            }
        }
        finally {
            cleanup?.();
        }
    },
})
    // =========================================================================
    // smithers chat create
    // =========================================================================
    .command("chat-create", {
    description: "Create and start a one-task auto-hijacked chat run.",
    options: chatCreateOptions,
    async run(c) {
        const fail = makeFail(c);
        const chatCwd = resolve(process.cwd(), c.options.cwd ?? ".");
        if (!existsSync(chatCwd)) {
            return fail({
                code: "PATH_NOT_FOUND",
                message: `Path does not exist: ${chatCwd}`,
                exitCode: 4,
            });
        }
        if (!statSync(chatCwd).isDirectory()) {
            return fail({
                code: "PATH_NOT_DIRECTORY",
                message: `Path is not a directory: ${chatCwd}`,
                exitCode: 4,
            });
        }
        try {
            const workflow = await buildInlineChatWorkflow({ engine: c.options.agent, cwd: chatCwd, prompt: CHAT_CREATE_PROMPT });
            setupSqliteCleanup(workflow);
            const result = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                rootDir: chatCwd,
            }));
            const adapter = new SmithersDb(workflow.db);
            const candidate = result.runId
                ? await resolveHijackCandidate(adapter, result.runId, c.options.agent)
                : null;
            if (!candidate) {
                if (result.status === "failed") {
                    return fail({
                        code: result.error?.code ?? "CHAT_CREATE_FAILED",
                        message: result.error?.message ?? `Chat run ${result.runId} failed.`,
                        exitCode: result.error?.code === "TASK_HIJACK_UNSUPPORTED" ? 4 : 1,
                    });
                }
                return fail({
                    code: "CHAT_CREATE_UNAVAILABLE",
                    message: `Chat run ${result.runId} did not produce a hijackable ${c.options.agent} session.`,
                    exitCode: 1,
                });
            }
            return c.ok({
                runId: result.runId,
                workflowName: "chat",
                agent: c.options.agent,
            }, {
                cta: withAgentNextSteps({ runId: result.runId, workflowId: "chat" }, [
                    { command: `hijack ${result.runId}`, description: "Open the chat session" },
                    { command: `inspect ${result.runId}`, description: "Inspect run state" },
                ], "Next steps:"),
            });
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError ? err.code : "CHAT_CREATE_FAILED",
                message: err?.message ?? String(err),
                exitCode: err instanceof SmithersError ? 4 : 1,
            });
        }
    },
})
    // =========================================================================
    // smithers hijack <run_id>
    // =========================================================================
    .command("hijack", {
    description: "Hand off the latest resumable agent session or conversation for a run.",
    args: hijackArgs,
    options: hijackOptions,
    async run(c) {
        const fail = makeFail(c);
        const { adapter, cleanup } = await findAndOpenDb();
        try {
            const run = await adapter.getRun(c.args.runId);
            if (!run) {
                return fail({
                    code: "RUN_NOT_FOUND",
                    message: `Run not found: ${c.args.runId}`,
                    exitCode: 4,
                });
            }
            let candidate = await resolveHijackCandidate(adapter, c.args.runId, c.options.target);
            const runIsLive = run.status === "running";
            const requestedAtMs = Date.now();
            if (runIsLive) {
                // `--target` accepts an agent engine OR a node id (the TUI's
                // HijackMode passes the selected node id). The engine's
                // hand-off check (maybeCompleteHijack) only understands engine
                // names, so resolve a node-id target to that node's recorded
                // engine before persisting the request; the raw target still
                // scopes candidate matching below, which understands both. (#23)
                const requestTarget = await resolveHijackRequestEngine(adapter, c.args.runId, c.options.target);
                const event = {
                    type: "RunHijackRequested",
                    runId: c.args.runId,
                    timestampMs: requestedAtMs,
                    ...(c.options.target ? { target: c.options.target } : {}),
                };
                await adapter.requestRunHijack(c.args.runId, requestedAtMs, requestTarget);
                await adapter.insertEventWithNextSeq({
                    runId: c.args.runId,
                    timestampMs: requestedAtMs,
                    type: "RunHijackRequested",
                    payloadJson: JSON.stringify(event),
                });
                runSync(trackEvent(event));
                try {
                    candidate = await waitForHijackCandidate(adapter, c.args.runId, {
                        target: c.options.target,
                        timeoutMs: c.options.timeoutMs,
                    });
                }
                catch (error) {
                    await adapter.clearRunHijack(c.args.runId).catch(() => undefined);
                    return fail({
                        code: "HIJACK_TIMEOUT",
                        message: error?.message ?? String(error),
                        exitCode: 4,
                    });
                }
            }
            if (!candidate) {
                return fail({
                    code: "HIJACK_UNAVAILABLE",
                    message: `No resumable agent session or conversation found for run ${c.args.runId}.`,
                    exitCode: 4,
                });
            }
            // --target may name the engine OR the node id; the candidate the
            // resolver returns matches on either, so reject only when it
            // matches neither. (#23)
            if (c.options.target &&
                candidate.engine !== c.options.target &&
                candidate.nodeId !== c.options.target) {
                return fail({
                    code: "HIJACK_TARGET_MISMATCH",
                    message: `Run ${c.args.runId} is resumable via ${candidate.engine} on node ${candidate.nodeId}, not ${c.options.target}. Pass an agent engine (e.g. claude-code, codex) or a node id from \`smithers tree ${c.args.runId}\`.`,
                    exitCode: 4,
                });
            }
            const resumeCommand = run.workflowPath
                ? `smithers up ${run.workflowPath} --resume --run-id ${c.args.runId}`
                : null;
            if (!c.options.launch) {
                const launchSpec = isNativeHijackCandidate(candidate)
                    ? buildHijackLaunchSpec(candidate)
                    : null;
                const launch = launchSpec
                    ? {
                        command: launchSpec.command,
                        args: launchSpec.args,
                        cwd: launchSpec.cwd,
                    }
                    : null;
                return c.ok({
                    runId: c.args.runId,
                    engine: candidate.engine,
                    mode: candidate.mode,
                    nodeId: candidate.nodeId,
                    attempt: candidate.attempt,
                    iteration: candidate.iteration,
                    resume: candidate.resume ?? null,
                    messageCount: candidate.messages?.length ?? 0,
                    cwd: candidate.cwd,
                    launch,
                    resumeCommand,
                });
            }
            let exitCode = 0;
            let resumedBySmithers = false;
            if (isNativeHijackCandidate(candidate)) {
                const launchSpec = buildHijackLaunchSpec(candidate);
                process.stderr.write(`[smithers] hijacking ${candidate.engine} session ${candidate.resume} from ${candidate.nodeId}#${candidate.attempt}\n`);
                exitCode = await launchHijackSession(launchSpec);
            }
            else {
                if (!candidate.messages?.length) {
                    return fail({
                        code: "HIJACK_CONVERSATION_MISSING",
                        message: `Run ${c.args.runId} did not persist a resumable conversation for ${candidate.engine}.`,
                        exitCode: 4,
                    });
                }
                const result = await launchConversationHijackSession(adapter, {
                    ...candidate,
                    mode: "conversation",
                    messages: candidate.messages,
                });
                await persistConversationHijackHandoff(adapter, candidate, result.messages);
                exitCode = result.code;
            }
            if (exitCode === 0 && runIsLive && run.workflowPath) {
                const pid = resumeRunDetached(run.workflowPath, c.args.runId);
                resumedBySmithers = true;
                process.stderr.write(`[smithers] returned control to Smithers${pid ? ` (pid ${pid})` : ""}\n`);
            }
            else if (resumeCommand) {
                process.stderr.write(`[smithers] return control to Smithers with:\n  ${resumeCommand}\n`);
            }
            if (exitCode !== 0) {
                return fail({
                    code: "HIJACK_LAUNCH_FAILED",
                    message: `${candidate.engine} exited with code ${exitCode}`,
                    exitCode,
                });
            }
            return c.ok({
                runId: c.args.runId,
                engine: candidate.engine,
                mode: candidate.mode,
                resumedSession: candidate.resume ?? null,
                resumedBySmithers,
            });
        }
        finally {
            cleanup();
        }
    },
})
    // =========================================================================
    // smithers inspect <run_id>
    // =========================================================================
.command("inspect", {
    description: "Output detailed run state. Structured output canonically uses nodes[].nodeId (legacy steps[].id remains for compatibility); --pool tallies attempt engine/model usage.",
    args: inspectArgs,
    options: inspectOptions,
    alias: { watch: "w", interval: "i" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                /**
       * @param {InspectSnapshot} snapshot
       */
                const renderInspect = (snapshot) => {
                    writeWatchOutput(c.format, snapshot.result);
                };
                if (c.options.watch) {
                    const intervalMs = resolveWatchIntervalMsOrFail("inspect", c.options.interval, fail);
                    const watchResult = await runPromise(Effect.tryPromise(() => runWatchLoop({
                        intervalSeconds: c.options.interval,
                        clearScreen: true,
                        fetch: () => buildInspectSnapshot(adapter, c.args.runId, { pool: c.options.pool }),
                        render: async (snapshot) => {
                            renderInspect(snapshot);
                        },
                        isTerminal: (snapshot) => isRunStatusTerminal(snapshot.status),
                    })).pipe(Effect.tap((result) => Effect.logDebug("watch loop completed").pipe(Effect.annotateLogs({
                        command: "inspect",
                        intervalMs,
                        tickCount: result.tickCount,
                        stoppedBySignal: result.stoppedBySignal,
                    }))), Effect.annotateLogs({ command: "inspect", intervalMs }), Effect.withLogSpan("cli:watch")));
                    if (watchResult.stoppedBySignal) {
                        process.exitCode = 0;
                    }
                    return c.ok(undefined);
                }
                const snapshot = await buildInspectSnapshot(adapter, c.args.runId, { pool: c.options.pool });
                return c.ok(snapshot.result, { cta: { description: snapshot.ctaDescription, commands: snapshot.ctaCommands } });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError && err.code === "RUN_NOT_FOUND") {
                return fail({
                    code: "RUN_NOT_FOUND",
                    message: err.message,
                    exitCode: 4,
                });
            }
            return fail({ code: "INSPECT_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers node <node_id> -r <run_id>
    // =========================================================================
    .command("node", {
    description: "Show enriched node details for debugging retries, tool calls, and output.",
    args: nodeArgs,
    options: nodeOptions,
    alias: { runId: "r", iteration: "i", watch: "w" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                /**
       * @param {any} detail
       */
                const renderNode = (detail) => {
                    const human = c.format === "json" || c.format === "jsonl"
                        ? undefined
                        : renderNodeDetailHuman(detail, {
                            expandAttempts: c.options.attempts,
                            expandTools: c.options.tools,
                        });
                    writeWatchOutput(c.format, detail, human);
                };
                if (c.options.watch) {
                    const intervalMs = resolveWatchIntervalMsOrFail("node", c.options.interval, fail);
                    const watchResult = await runPromise(Effect.tryPromise(() => runWatchLoop({
                        intervalSeconds: c.options.interval,
                        clearScreen: true,
                        fetch: () => buildNodeSnapshot(adapter, {
                            runId: c.options.runId,
                            nodeId: c.args.nodeId,
                            iteration: c.options.iteration,
                        }),
                        render: async (snapshot) => {
                            renderNode(snapshot.detail);
                        },
                        isTerminal: (snapshot) => isRunStatusTerminal(snapshot.status),
                    })).pipe(Effect.tap((result) => Effect.logDebug("watch loop completed").pipe(Effect.annotateLogs({
                        command: "node",
                        runId: c.options.runId,
                        nodeId: c.args.nodeId,
                        intervalMs,
                        tickCount: result.tickCount,
                        stoppedBySignal: result.stoppedBySignal,
                    }))), Effect.annotateLogs({
                        command: "node",
                        runId: c.options.runId,
                        nodeId: c.args.nodeId,
                        intervalMs,
                    }), Effect.withLogSpan("cli:watch")));
                    if (watchResult.stoppedBySignal) {
                        process.exitCode = 0;
                    }
                    return c.ok(undefined);
                }
                const detail = await runPromise(aggregateNodeDetailEffect(adapter, {
                    runId: c.options.runId,
                    nodeId: c.args.nodeId,
                    iteration: c.options.iteration,
                }));
                if (c.format === "json") {
                    return c.ok(detail);
                }
                const rendered = renderNodeDetailHuman(detail, {
                    expandAttempts: c.options.attempts,
                    expandTools: c.options.tools,
                });
                return c.ok(rendered, {
                    cta: withAgentNextSteps({ runId: c.options.runId }, [
                        {
                            command: `inspect ${c.options.runId}`,
                            description: "Inspect overall run state",
                        },
                        {
                            command: `chat ${c.options.runId}`,
                            description: "View agent chat for this run",
                        },
                        {
                            command: `node ${c.args.nodeId} -r ${c.options.runId} --attempts`,
                            description: "Expand every attempt",
                        },
                        {
                            command: `node ${c.args.nodeId} -r ${c.options.runId} --tools`,
                            description: "Expand tool payloads",
                        },
                    ]),
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            const isMissingNode = err instanceof SmithersError && err.code === "NODE_NOT_FOUND";
            return fail({
                code: isMissingNode ? "NODE_NOT_FOUND" : "NODE_DETAIL_FAILED",
                message: err instanceof SmithersError
                    ? err.summary
                    : (err?.message ?? String(err)),
                exitCode: isMissingNode ? 4 : 1,
            });
        }
    },
})
    // =========================================================================
    // smithers why <run_id>
    // =========================================================================
    .command("why", {
    description: "Explain why a run is currently blocked or paused.",
    args: whyArgs,
    options: whyOptions,
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const diagnosis = await runPromise(diagnoseRunEffect(adapter, c.args.runId));
                if (c.options.json) {
                    return c.ok(JSON.stringify(diagnosis, null, 2));
                }
                if (c.format === "json") {
                    return c.ok(diagnosis);
                }
                return c.ok(renderWhyDiagnosisHuman(diagnosis), {
                    cta: withAgentNextSteps({ runId: c.args.runId }, diagnosisCtaCommands(diagnosis)),
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError && err.code === "RUN_NOT_FOUND") {
                return fail({
                    code: "RUN_NOT_FOUND",
                    message: err.message,
                    exitCode: 4,
                });
            }
            return fail({ code: "WHY_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers status <run_id>
    // =========================================================================
    .command("status", {
    description: "Concise run health at a glance: verdict, node counts, agent/model mix, throughput, and the nodes gating progress.",
    args: statusArgs,
    options: statusOptions,
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const summary = await buildRunStatusSummary(adapter, c.args.runId, {
                    ...(c.options.window
                        ? { recentWindowMs: Math.floor(c.options.window * 60_000) }
                        : {}),
                });
                if (c.options.json) {
                    return c.ok(JSON.stringify(summary, null, 2));
                }
                if (c.format === "json") {
                    return c.ok(summary);
                }
                return c.ok(renderRunStatusHuman(summary), {
                    cta: withAgentNextSteps({ runId: c.args.runId }, runStatusCtaCommands(summary)),
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError && err.code === "RUN_NOT_FOUND") {
                return fail({
                    code: "RUN_NOT_FOUND",
                    message: err.message,
                    exitCode: 4,
                });
            }
            return fail({ code: "STATUS_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers what
    // =========================================================================
    .command("what", {
    description: "Summarize what happened in a run or node: a cheap fast agent narrates the recorded facts (deterministic recap when no agent is available).",
    args: whatArgs,
    options: whatOptions,
    alias: { node: "n", iteration: "i" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                let runId = c.args.runId;
                if (!runId) {
                    const latestRuns = await adapter.listRuns(1);
                    runId = latestRuns[0]?.runId;
                }
                if (!runId) {
                    return fail({ code: "RUN_NOT_FOUND", message: "No runs found.", exitCode: 4 });
                }
                const result = await whatHappened({
                    adapter,
                    runId,
                    nodeId: c.options.node ?? null,
                    iteration: c.options.iteration,
                    cwd: process.cwd(),
                    ...(c.options.timeout ? { timeoutMs: c.options.timeout * 1000 } : {}),
                });
                if (c.options.json || c.format === "json") {
                    return c.ok({
                        runId,
                        nodeId: c.options.node ?? null,
                        summary: result.summary,
                        agentId: result.agentId,
                        source: result.source,
                        facts: result.facts,
                    });
                }
                const ownCommands = c.options.node
                    ? [{ command: `node ${c.options.node} --run-id ${runId}`, description: "Full node detail (attempts, tools, output)" }]
                    : [{ command: `inspect ${runId}`, description: "Full run detail" }];
                return c.ok(result.summary, { cta: withAgentNextSteps({ runId }, ownCommands) });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            if (err instanceof SmithersError && (err.code === "RUN_NOT_FOUND" || err.code === "NODE_NOT_FOUND")) {
                return fail({ code: err.code, message: err.message, exitCode: 4 });
            }
            return fail({ code: "WHAT_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers human inbox|answer|cancel
    // =========================================================================
    .command("human", {
    description: "List and resolve durable human requests.",
    args: humanArgs,
    options: humanOptions,
    async run(c) {
        const fail = makeFail(c);
        const action = c.args.action.trim().toLowerCase();
        if (action !== "inbox" && action !== "answer" && action !== "cancel") {
            return fail({
                code: "INVALID_HUMAN_ACTION",
                message: `Unknown smithers human action: ${c.args.action}`,
                exitCode: 4,
            });
        }
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                if (action === "inbox") {
                    const rows = await adapter.listPendingHumanRequests();
                    const requests = rows.map((row) => ({
                        requestId: row.requestId,
                        runId: row.runId,
                        workflowName: row.workflowName ?? null,
                        nodeId: row.nodeId,
                        iteration: row.iteration ?? 0,
                        kind: row.kind,
                        prompt: row.prompt,
                        status: row.status,
                        requestedAtMs: row.requestedAtMs ?? null,
                        requestedAt: typeof row.requestedAtMs === "number"
                            ? new Date(row.requestedAtMs).toISOString()
                            : null,
                        age: typeof row.requestedAtMs === "number"
                            ? formatAge(row.requestedAtMs)
                            : "unknown",
                        timeoutAtMs: row.timeoutAtMs ?? null,
                    }));
                    if (c.format === "json" || c.format === "jsonl") {
                        return c.ok({ requests });
                    }
                    return c.ok(renderHumanInboxHuman(requests));
                }
                const requestId = c.args.requestId?.trim();
                if (!requestId) {
                    return fail({
                        code: "HUMAN_REQUEST_ID_REQUIRED",
                        message: `smithers human ${action} requires <request-id>`,
                        exitCode: 4,
                    });
                }
                await adapter.expireStaleHumanRequests();
                const request = await adapter.getHumanRequest(requestId);
                if (!request) {
                    return fail({
                        code: "HUMAN_REQUEST_NOT_FOUND",
                        message: `Human request not found: ${requestId}`,
                        exitCode: 4,
                    });
                }
                if (request.status !== "pending") {
                    return fail({
                        code: "HUMAN_REQUEST_NOT_PENDING",
                        message: `Human request ${requestId} is ${request.status}, not pending.`,
                        exitCode: 4,
                    });
                }
                const approval = await adapter.getApproval(request.runId, request.nodeId, request.iteration);
                if (action === "answer") {
                    if (!c.options.value) {
                        return fail({
                            code: "HUMAN_REQUEST_VALUE_REQUIRED",
                            message: "smithers human answer requires --value <json>",
                            exitCode: 4,
                        });
                    }
                    const parsedValue = tryParseJsonInput(c.options.value, "human request value");
                    if (!parsedValue.ok)
                        return fail(parsedValue.error);
                    const value = parsedValue.value;
                    const validation = validateHumanRequestValue(request, value);
                    if (!validation.ok) {
                        return fail({
                            code: validation.code,
                            message: validation.message,
                            exitCode: 4,
                        });
                    }
                    const answeredAtMs = Date.now();
                    if (isHumanRequestPastTimeout(request, answeredAtMs)) {
                        await adapter.expireStaleHumanRequests(answeredAtMs);
                        return fail({
                            code: "HUMAN_REQUEST_EXPIRED",
                            message: `Human request ${requestId} expired at ${new Date(request.timeoutAtMs).toISOString()}.`,
                            exitCode: 4,
                        });
                    }
                    const responseJson = JSON.stringify(value);
                    if (approval?.status === "requested") {
                        await Effect.runPromise(approveNode(adapter, request.runId, request.nodeId, request.iteration, responseJson, c.options.by));
                    }
                    await adapter.answerHumanRequest(requestId, responseJson, answeredAtMs, c.options.by ?? null);
                    return c.ok({
                        requestId,
                        runId: request.runId,
                        nodeId: request.nodeId,
                        iteration: request.iteration,
                        status: "answered",
                    });
                }
                if (approval?.status === "requested") {
                    await Effect.runPromise(denyNode(adapter, request.runId, request.nodeId, request.iteration, `Human request cancelled: ${requestId}`, c.options.by));
                }
                await adapter.cancelHumanRequest(requestId);
                return c.ok({
                    requestId,
                    runId: request.runId,
                    nodeId: request.nodeId,
                    iteration: request.iteration,
                    status: "cancelled",
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({
                code: "HUMAN_REQUEST_COMMAND_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    // =========================================================================
    // smithers ask-human <prompt>
    // =========================================================================
    .command("ask-human", {
    description: "Raise a blocking human-approval request from inside a run and wait for the decision. Use when blocked, uncertain, or about to do something irreversible — never guess.",
    args: askHumanArgs,
    options: askHumanOptions,
    alias: { runId: "r", node: "n" },
    async run(c) {
        const fail = makeFail(c);
        const prompt = c.args.prompt?.trim();
        if (!prompt) {
            return fail({
                code: "ASK_HUMAN_PROMPT_REQUIRED",
                message: "smithers ask-human requires a prompt (the decision to put to a human).",
                exitCode: 4,
            });
        }
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                let context;
                try {
                    context = await resolveAskHumanContext(adapter, {
                        runId: c.options.runId,
                        nodeId: c.options.node,
                        iteration: c.options.iteration,
                    });
                }
                catch (err) {
                    return fail({
                        code: err?.code ?? "ASK_HUMAN_CONTEXT_FAILED",
                        message: err?.message ?? String(err),
                        exitCode: 4,
                    });
                }
                const choices = parseChoices(c.options.choices);
                const kindFields = buildAskKindFields(choices);
                const requestedAtMs = Date.now();
                const timeoutAtMs = typeof c.options.timeout === "number" && c.options.timeout > 0
                    ? requestedAtMs + Math.floor(c.options.timeout * 1_000)
                    : null;
                const row = buildAgentAskRequestRow({
                    runId: context.runId,
                    nodeId: context.nodeId,
                    iteration: context.iteration,
                    prompt: buildAskPromptText(prompt, c.options.context),
                    unique: buildAskUniqueToken(),
                    requestedAtMs,
                    kind: kindFields.kind,
                    optionsJson: kindFields.optionsJson,
                    schemaJson: kindFields.schemaJson,
                    timeoutAtMs,
                });
                await adapter.insertHumanRequest(row);
                // Operator instructions go to stderr so --format json stdout stays clean
                // for the calling agent to parse. Use a synchronous fd write: when stderr
                // is a pipe, process.exit() at command end would truncate a buffered
                // (async) stream write.
                writeSync(2, `${formatAskHumanResolveHelp(row.requestId, choices)}\n`);
                const pollIntervalMs = typeof c.options.poll === "number" && c.options.poll > 0
                    ? Math.floor(c.options.poll * 1_000)
                    : undefined;
                const abortController = new AbortController();
                const onSignal = () => abortController.abort();
                process.once("SIGINT", onSignal);
                process.once("SIGTERM", onSignal);
                let outcome;
                try {
                    outcome = await waitForHumanAnswer(adapter, row.requestId, {
                        pollIntervalMs,
                        signal: abortController.signal,
                    });
                }
                finally {
                    process.removeListener("SIGINT", onSignal);
                    process.removeListener("SIGTERM", onSignal);
                }
                const base = {
                    requestId: row.requestId,
                    runId: context.runId,
                    nodeId: context.nodeId,
                    iteration: context.iteration,
                    status: outcome.status,
                };
                if (outcome.status === "answered") {
                    let response = null;
                    try {
                        response = outcome.responseJson != null
                            ? JSON.parse(outcome.responseJson)
                            : null;
                    }
                    catch {
                        response = outcome.responseJson ?? null;
                    }
                    return c.ok({
                        ...base,
                        decision: "approved",
                        response,
                        answeredBy: outcome.answeredBy ?? null,
                    });
                }
                const exitCodeByStatus = {
                    cancelled: 2,
                    aborted: 2,
                    expired: 3,
                    missing: 4,
                };
                const messageByStatus = {
                    cancelled: `Human request ${row.requestId} was cancelled — do not proceed.`,
                    aborted: `Waiting on ${row.requestId} was interrupted — do not proceed.`,
                    expired: `Human request ${row.requestId} expired before a human responded — do not proceed.`,
                    missing: `Human request ${row.requestId} disappeared from the store.`,
                };
                return fail({
                    code: `ASK_HUMAN_${String(outcome.status).toUpperCase()}`,
                    message: messageByStatus[outcome.status] ??
                        `Human request ${row.requestId} ended as ${outcome.status}.`,
                    exitCode: exitCodeByStatus[outcome.status] ?? 1,
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({
                code: "ASK_HUMAN_COMMAND_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    // =========================================================================
    // smithers alerts list|ack|resolve|silence
    // =========================================================================
    .command("alerts", {
    description: "List and manage durable alert instances.",
    args: alertsArgs,
    options: alertsOptions,
    async run(c) {
        const fail = makeFail(c);
        const action = c.args.action.trim().toLowerCase();
        if (action !== "list" &&
            action !== "ack" &&
            action !== "resolve" &&
            action !== "silence") {
            return fail({
                code: "INVALID_ALERT_ACTION",
                message: `Unknown smithers alerts action: ${c.args.action}`,
                exitCode: 4,
            });
        }
        const requestedAlertId = c.args.alertId?.trim();
        if (action !== "list" && !requestedAlertId) {
            return fail({
                code: "ALERT_ID_REQUIRED",
                message: `smithers alerts ${action} requires <id>`,
                exitCode: 4,
            });
        }
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                if (action === "list") {
                    const rows = await adapter.listAlerts(200, [
                        "firing",
                        "acknowledged",
                        "silenced",
                    ]);
                    const alerts = rows.map((row) => ({
                        alertId: row.alertId,
                        runId: row.runId ?? null,
                        policyName: row.policyName,
                        severity: row.severity,
                        status: row.status,
                        firedAtMs: row.firedAtMs ?? null,
                        firedAt: typeof row.firedAtMs === "number"
                            ? new Date(row.firedAtMs).toISOString()
                            : null,
                        resolvedAtMs: row.resolvedAtMs ?? null,
                        resolvedAt: typeof row.resolvedAtMs === "number"
                            ? new Date(row.resolvedAtMs).toISOString()
                            : null,
                        acknowledgedAtMs: row.acknowledgedAtMs ?? null,
                        acknowledgedAt: typeof row.acknowledgedAtMs === "number"
                            ? new Date(row.acknowledgedAtMs).toISOString()
                            : null,
                        age: typeof row.firedAtMs === "number"
                            ? formatAge(row.firedAtMs)
                            : "unknown",
                        message: row.message,
                        detailsJson: row.detailsJson ?? null,
                    }));
                    if (c.format === "json" || c.format === "jsonl") {
                        return c.ok({ alerts });
                    }
                    return c.ok(renderAlertsHuman(alerts));
                }
                const alertId = requestedAlertId;
                if (!alertId) {
                    return fail({
                        code: "ALERT_ID_REQUIRED",
                        message: `smithers alerts ${action} requires <id>`,
                        exitCode: 4,
                    });
                }
                const existing = await adapter.getAlert(alertId);
                if (!existing) {
                    return fail({
                        code: "ALERT_NOT_FOUND",
                        message: `Alert not found: ${alertId}`,
                        exitCode: 4,
                    });
                }
                const alert = action === "ack"
                    ? await adapter.acknowledgeAlert(alertId, Date.now())
                    : action === "resolve"
                        ? await adapter.resolveAlert(alertId, Date.now())
                        : await adapter.silenceAlert(alertId);
                if (!alert) {
                    return fail({
                        code: "ALERT_NOT_FOUND",
                        message: `Alert not found: ${alertId}`,
                        exitCode: 4,
                    });
                }
                const payload = {
                    alertId: alert.alertId,
                    runId: alert.runId ?? null,
                    policyName: alert.policyName,
                    severity: alert.severity,
                    status: alert.status,
                    firedAtMs: alert.firedAtMs ?? null,
                    resolvedAtMs: alert.resolvedAtMs ?? null,
                    acknowledgedAtMs: alert.acknowledgedAtMs ?? null,
                    message: alert.message,
                    detailsJson: alert.detailsJson ?? null,
                };
                if (c.format === "json" || c.format === "jsonl") {
                    return c.ok(payload);
                }
                return c.ok(`Alert ${payload.alertId} is ${payload.status}.`);
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({
                code: "ALERTS_FAILED",
                message: err?.message ?? String(err),
                exitCode: 1,
            });
        }
    },
})
    // =========================================================================
    // smithers approve <run_id>
    // =========================================================================
    .command("approve", {
    description: "Approve a paused approval gate. Auto-detects the pending node if only one exists.",
    args: approveArgs,
    options: approveOptions,
    alias: { node: "n" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const target = await resolveApprovalCommandTarget(adapter, c.args.runId, c.options);
                if (!target.ok) {
                    return fail(target);
                }
                const { nodeId, iteration } = target;
                await Effect.runPromise(approveNode(adapter, c.args.runId, nodeId, iteration, c.options.note, c.options.by));
                const runAfterApproval = await adapter.getRun(c.args.runId);
                const isDetached = !runAfterApproval ||
                    runAfterApproval.status === "waiting-event" ||
                    runAfterApproval.status === "waiting-approval";
                const ctaCommands = [
                    { command: `logs ${c.args.runId}`, description: "Tail run logs" },
                    { command: `ps`, description: "List all runs" },
                ];
                if (isDetached && runAfterApproval?.workflowPath) {
                    ctaCommands.unshift({
                        command: `up ${runAfterApproval.workflowPath} --resume --run-id ${c.args.runId}`,
                        description: "Resume the paused run",
                    });
                }
                // The resume command must actually parse: `workflow run
                // --resume <runId>` swallows the run id as the --resume value
                // and fails WORKFLOW_REQUIRED, so mirror the runnable form the
                // ctaCommands / signal / hijack paths already use. (#24)
                const resumeNote = runAfterApproval?.workflowPath
                    ? `smithers up ${runAfterApproval.workflowPath} --resume --run-id ${c.args.runId}`
                    : `smithers up <workflow-file> --resume --run-id ${c.args.runId}`;
                return c.ok({
                    runId: c.args.runId,
                    nodeId,
                    status: "approved",
                    ...(isDetached
                        ? { note: `Approval recorded. If running detached, resume the run to continue: ${resumeNote}` }
                        : {}),
                }, {
                    cta: {
                        commands: ctaCommands,
                    },
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({ code: "APPROVE_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers signal <run_id> <signal_name>
    // =========================================================================
    .command("signal", {
    description: "Deliver a durable signal to a run waiting on <Signal> or <WaitForEvent>.",
    args: signalArgs,
    options: signalOptions,
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const parsedPayload = tryParseJsonInput(c.options.data, "signal data");
                if (!parsedPayload.ok)
                    return fail(parsedPayload.error);
                const payload = parsedPayload.value ?? {};
                const run = await adapter.getRun(c.args.runId);
                if (!run) {
                    return fail({
                        code: "RUN_NOT_FOUND",
                        message: `Run not found: ${c.args.runId}`,
                        exitCode: 4,
                    });
                }
                const delivered = await Effect.runPromise(signalRun(adapter, c.args.runId, c.args.signalName, payload, {
                    correlationId: c.options.correlation,
                    receivedBy: c.options.by,
                }));
                const commands = [
                    { command: `why ${c.args.runId}`, description: "Explain remaining blockers" },
                    { command: `logs ${c.args.runId}`, description: "Tail run logs" },
                ];
                if (run.workflowPath) {
                    commands.unshift({
                        command: `up ${run.workflowPath} --resume --run-id ${c.args.runId}`,
                        description: "Resume the paused run",
                    });
                }
                return c.ok({
                    runId: c.args.runId,
                    signalName: c.args.signalName,
                    correlationId: c.options.correlation ?? null,
                    seq: delivered.seq,
                    status: "signalled",
                }, {
                    cta: {
                        commands,
                    },
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError && err.code === "RUN_NOT_FOUND"
                    ? "RUN_NOT_FOUND"
                    : "SIGNAL_FAILED",
                message: err?.message ?? String(err),
                exitCode: err instanceof SmithersError && err.code === "RUN_NOT_FOUND" ? 4 : 1,
            });
        }
    },
})
    // =========================================================================
    // smithers deny <run_id>
    // =========================================================================
    .command("deny", {
    description: "Deny a paused approval gate.",
    args: approveArgs,
    options: approveOptions,
    alias: { node: "n" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const target = await resolveApprovalCommandTarget(adapter, c.args.runId, c.options);
                if (!target.ok) {
                    return fail(target);
                }
                const { nodeId, iteration } = target;
                await Effect.runPromise(denyNode(adapter, c.args.runId, nodeId, iteration, c.options.note, c.options.by));
                return c.ok({ runId: c.args.runId, nodeId, status: "denied" }, {
                    cta: {
                        commands: [
                            { command: `logs ${c.args.runId}`, description: "Tail run logs" },
                            { command: `ps`, description: "List all runs" },
                        ],
                    },
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({ code: "DENY_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers cancel <run_id>
    // =========================================================================
    .command("cancel", {
    description: "Safely halt agents and terminate a run.",
    args: cancelArgs,
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const run = await adapter.getRun(c.args.runId);
                if (!run) {
                    return fail({ code: "RUN_NOT_FOUND", message: `Run not found: ${c.args.runId}`, exitCode: 4 });
                }
                if (!isCancellableRunStatus(run.status)) {
                    // Terminal root. Idempotent completion: a previous cancel may
                    // have died between flipping the root and sweeping its
                    // descendants, so if any linked descendant is still
                    // cancellable, finish the cascade instead of erroring.
                    // Use the cascade's OWN lineage (fork subtrees pruned): a fork is
                    // spared by the sweep, so counting it here would report success
                    // while cancelling nothing instead of RUN_NOT_ACTIVE.
                    const descendants = await listCascadeLineage(adapter, c.args.runId);
                    let hasCancellableDescendant = false;
                    for (const row of descendants) {
                        if (row.depth === 0)
                            continue;
                        const child = await adapter.getRun(row.runId);
                        if (child && isCancellableRunStatus(child.status)) {
                            hasCancellableDescendant = true;
                            break;
                        }
                    }
                    let needsCancellationRepair = false;
                    if (run.status === "cancelled" || run.status === "canceled") {
                        const pendingApprovals = await adapter.listPendingApprovals(c.args.runId);
                        const pendingHumans = (await adapter.listPendingHumanRequests()).some((request) => request.runId === c.args.runId && request.status === "pending");
                        const activeAttempts = (await adapter.listAttemptsForRun(c.args.runId)).some((attempt) => ["in-progress", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(attempt.state));
                        const waitingNodes = (await adapter.listNodes(c.args.runId)).some((node) => ["in-progress", "waiting-approval", "waiting_approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(node.state));
                        needsCancellationRepair = pendingApprovals.length > 0 || pendingHumans || activeAttempts || waitingNodes;
                    }
                    if (!hasCancellableDescendant && !needsCancellationRepair) {
                        return fail({ code: "RUN_NOT_ACTIVE", message: `Run is not active (status: ${run.status})`, exitCode: 4 });
                    }
                }
                // Cascade: cancel the run plus every linked descendant. Live runs
                // (fresh heartbeat) get the durable cancel request — a live engine
                // only observes cancellation by polling `cancel_requested_at_ms`
                // (its cancelWatcher) and would clobber a bare status flip with
                // "finished" on completion. Stale/waiting/paused runs are flipped
                // directly and any surviving detached owner process group is
                // terminated.
                const summary = await cascadeCancelRun(adapter, c.args.runId);
                const rootAction = summary.root?.action ?? "already-terminal";
                const descendantReport = {
                    discovered: summary.descendants.length,
                    cancelRequested: summary.descendants.filter((d) => d.action === "cancel-requested").map((d) => d.runId),
                    cancelled: summary.descendants.filter((d) => d.action === "cancelled").map((d) => d.runId),
                    alreadyTerminal: summary.descendants.filter((d) => d.action === "already-terminal").map((d) => d.runId),
                };
                process.exitCode = 2;
                if (rootAction === "cancel-requested") {
                    return c.ok({
                        runId: c.args.runId,
                        status: "cancel-requested",
                        descendants: descendantReport,
                        terminatedOwners: summary.terminatedOwners,
                    }, {
                        cta: {
                            commands: [
                                { command: `logs ${c.args.runId} -f`, description: "Watch the run stop" },
                                { command: `ps`, description: "List all runs" },
                            ],
                        },
                    });
                }
                return c.ok({
                    runId: c.args.runId,
                    status: rootAction === "cancelled" ? "cancelled" : run.status,
                    cancelledAttempts: summary.cancelledAttempts,
                    descendants: descendantReport,
                    terminatedOwners: summary.terminatedOwners,
                }, {
                    cta: {
                        commands: [
                            { command: `ps`, description: "List all runs" },
                        ],
                    },
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({ code: "CANCEL_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers pause
    // =========================================================================
    .command("pause", {
    description: "Gracefully pause a run: stop scheduling new tasks, let in-flight tasks finish, then park it resumably.",
    args: pauseArgs,
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const run = await adapter.getRun(c.args.runId);
                if (!run) {
                    return fail({ code: "RUN_NOT_FOUND", message: `Run not found: ${c.args.runId}`, exitCode: 4 });
                }
                if (run.status === "paused") {
                    return c.ok({ runId: c.args.runId, status: "paused" });
                }
                // Graceful pause only makes sense for a run a live engine is actively
                // driving: the engine's pause-watcher stops scheduling, lets in-flight
                // tasks finish, then writes the resumable "paused" status. A suspended
                // run (waiting-*) is already parked; use `smithers cancel` to stop it.
                if (run.status !== "running" || !isRunHeartbeatFresh(run)) {
                    return fail({ code: "RUN_NOT_ACTIVE", message: `Run is not actively executing (status: ${run.status}); only a live run can be gracefully paused.`, exitCode: 4 });
                }
                await adapter.requestRunPause(c.args.runId, Date.now());
                process.exitCode = 2;
                return c.ok({
                    runId: c.args.runId,
                    status: "pause-requested",
                }, {
                    cta: {
                        commands: [
                            { command: `ps`, description: "See when it reaches paused" },
                            { command: `up --resume ${c.args.runId} -d`, description: "Resume the paused run" },
                        ],
                    },
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({ code: "PAUSE_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers down
    // =========================================================================
    .command("down", {
    description: "Cancel all active runs. Like 'docker compose down' for workflows.",
    options: z.object({
        force: z.boolean().default(false).describe("Cancel runs even if they still appear live (default only cancels stale runs)"),
    }),
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const activeRuns = await adapter.listRuns(DOWN_ACTIVE_RUN_SCAN_LIMIT, "running");
                const waitingApprovalRuns = await adapter.listRuns(DOWN_ACTIVE_RUN_SCAN_LIMIT, "waiting-approval");
                const waitingEventRuns = await adapter.listRuns(DOWN_ACTIVE_RUN_SCAN_LIMIT, "waiting-event");
                const waitingTimerRuns = await adapter.listRuns(DOWN_ACTIVE_RUN_SCAN_LIMIT, "waiting-timer");
                const waitingQuotaRuns = await adapter.listRuns(DOWN_ACTIVE_RUN_SCAN_LIMIT, "waiting-quota");
                // A paused run is a durable, resumable state with no live engine;
                // include it so `down` can terminate it. Its heartbeat is nulled
                // (stale), so the fresh-heartbeat guard flips it to cancelled
                // without --force via the direct-flip path below.
                const pausedRuns = await adapter.listRuns(DOWN_ACTIVE_RUN_SCAN_LIMIT, "paused");
                const allActive = [
                    ...activeRuns,
                    ...waitingApprovalRuns,
                    ...waitingEventRuns,
                    ...waitingTimerRuns,
                    ...waitingQuotaRuns,
                    ...pausedRuns,
                ];
                if (allActive.length === 0) {
                    return c.ok({ cancelled: 0, message: "No active runs to cancel." });
                }
                const now = Date.now();
                let cancelled = 0;
                let skipped = 0;
                for (const run of allActive) {
                    if (isRunHeartbeatFresh(run) && !c.options.force) {
                        process.stderr.write(`• Skipped (still live): ${run.runId}. Use --force to cancel anyway.\n`);
                        skipped++;
                        continue;
                    }
                    // Atomically claim terminal cancellation before terminating
                    // any surviving owner group. The claim fences a healthy or
                    // hung engine from racing this shutdown with a completion.
                    const { cancellation: result } = await finalizeCancelledOwnedRun(adapter, run, { now });
                    if (result.won || result.repaired) {
                        removeDetachedRunLog(run, { cwd: cliWorkspace.cwd() });
                        process.stderr.write(`⊘ Cancelled: ${run.runId}\n`);
                        cancelled++;
                    }
                    else {
                        skipped++;
                    }
                }
                if (cancelled === 0 && skipped > 0) {
                    return c.ok({ cancelled, skipped, message: "All active runs are still live. Use --force to cancel them." });
                }
                return c.ok({ cancelled, skipped, runs: allActive.map((r) => r.runId) }, { cta: { commands: [{ command: `ps`, description: "Verify all runs stopped" }] } });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({ code: "DOWN_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers graph <workflow>
    // =========================================================================
    .command("graph", {
    description: "Render the workflow graph without executing it.",
    args: workflowArgs,
    options: graphOptions,
    alias: { runId: "r" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const workflowFile = resolveWorkflowArg(c.args.workflow);
            const resolvedWorkflowPath = resolve(process.cwd(), workflowFile);
            const workflow = await loadWorkflow(workflowFile);
            ensureSmithersTables(workflow.db);
            const schema = resolveSchema(workflow.db);
            const inputTable = schema.input;
            let inputRow;
            if (c.options.input) {
                const parsedInput = tryParseJsonInput(c.options.input, "input");
                if (!parsedInput.ok)
                    return fail(parsedInput.error);
                inputRow = parsedInput.value;
            }
            else if (inputTable) {
                inputRow = (await loadInput(workflow.db, inputTable, c.options.runId)) ?? {};
            }
            else {
                inputRow = {};
            }
            const outputs = await loadOutputs(workflow.db, schema, c.options.runId);
            const ctx = new SmithersCtx({
                runId: c.options.runId,
                iteration: 0,
                input: inputRow ?? {},
                outputs,
            });
            const baseRootDir = resolveLaunchRootDir(c.options.root);
            const snap = await Effect.runPromise(renderFrame(workflow, ctx, {
                baseRootDir,
                workflowPath: resolvedWorkflowPath,
            }));
            const seen = new WeakSet();
            const stripPrompts = c.options.compact === true;
            return c.ok(JSON.parse(JSON.stringify(snap, (key, value) => {
                if (typeof value === "function")
                    return undefined;
                if (stripPrompts && key === "text" && typeof value === "string")
                    return `<text omitted: ${value.length} chars>`;
                if (typeof value === "object" && value !== null) {
                    if (seen.has(value))
                        return undefined;
                    seen.add(value);
                }
                return value;
            })), {
                cta: buildAgentNextSteps({
                    workflowId: workflowIdFromPath(workflowFile),
                    workflowFile,
                    runId: c.options.runId,
                    justRan: "graph",
                }),
            });
        }
        catch (err) {
            return fail({ code: "GRAPH_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers snapshots <runId>  /  smithers restore <runId> --node <id>
    // =========================================================================
    .command("snapshots", {
    description: "List durability snapshots (workspace checkpoints) for a run.",
    args: z.object({
        runId: z.string().describe("Run ID to list snapshots for"),
    }),
    options: z.object({
        json: z.boolean().default(false).describe("Emit rows as JSON"),
    }),
    alias: { json: "j" },
    run(c) {
        return runDevtoolsCommandWithTelemetry("snapshots", c, async (io) => {
            const { runSnapshotsOnce } = await import("./snapshots.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const result = await runSnapshotsOnce({
                    adapter,
                    runId: c.args.runId,
                    json: c.options.json,
                    stdout: c.options.json ? { write: writeStdoutSync } : io.stdout,
                });
                if (result.exitCode === 0 && !c.options.json && !c.formatExplicit)
                    writeAgentNextStepsHuman({ runId: c.args.runId });
                return result.exitCode;
            } finally {
                cleanup();
            }
        });
    },
})
    .command("restore", {
    description: "Restore a worktree to a durability checkpoint (latest for the node, or --seq).",
    args: z.object({
        runId: z.string().describe("Run ID containing the checkpoint"),
        nodeId: z.string().describe("Node ID whose worktree to restore"),
    }),
    options: z.object({
        iteration: z.number().int().min(0).optional().describe("Loop iteration"),
        seq: z.number().int().min(0).optional().describe("Checkpoint seq (default: latest)"),
    }),
    run(c) {
        return runDevtoolsCommandWithTelemetry("restore", c, async (io) => {
            const { runRestoreOnce } = await import("./restore.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const result = await runRestoreOnce({
                    adapter,
                    runId: c.args.runId,
                    nodeId: c.args.nodeId,
                    iteration: c.options.iteration,
                    seq: c.options.seq,
                    stdout: io.stdout,
                    stderr: io.stderr,
                });
                return result.exitCode;
            } finally {
                cleanup();
            }
        });
    },
})
    .command("snapshot-hook", {
    description: "Internal: PostToolUse hook that requests a Tier 1 durability snapshot.",
    args: z.object({}),
    options: z.object({}),
    run() {
        return (async () => {
            const { runSnapshotHookOnce } = await import("./snapshot-hook.js");
            const result = await runSnapshotHookOnce({});
            return result.exitCode;
        })();
    },
})
    // =========================================================================
    // smithers revert <workflow>
    // =========================================================================
    .command("revert", {
    description: "Revert the workspace to a previous task attempt's filesystem state.",
    args: workflowArgs,
    options: revertOptions,
    alias: { runId: "r", nodeId: "n" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
            try {
                const result = await revertToAttempt(adapter, {
                    runId: c.options.runId,
                    nodeId: c.options.nodeId,
                    iteration: c.options.iteration,
                    attempt: c.options.attempt,
                    onProgress: (e) => console.log(JSON.stringify(e)),
                });
                process.exitCode = result.success ? 0 : 1;
                return c.ok(result);
            }
            finally {
                cleanup?.();
            }
        }
        catch (err) {
            return fail({ code: "REVERT_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers retry-task <workflow>
    // =========================================================================
    .command("retry-task", {
    description: "Retry a specific task within a run, then resume the workflow.",
    args: workflowArgs,
    options: z.object({
        runId: z.string().describe("Run ID containing the task"),
        nodeId: z.string().describe("Task/node ID to retry"),
        iteration: z.number().int().default(0).describe("Loop iteration"),
        deps: z.boolean().default(true).describe("Also reset dependents. Use --no-deps to reset only this node."),
        force: z.boolean().default(false).describe("Allow retry even if run is still running"),
    }),
    alias: { runId: "r", nodeId: "n" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
            try {
                const onProgress = buildProgressReporter();
                const resetResult = await retryTask(adapter, {
                    runId: c.options.runId,
                    nodeId: c.options.nodeId,
                    iteration: c.options.iteration,
                    resetDependents: c.options.deps,
                    force: c.options.force,
                    onProgress,
                });
                if (!resetResult.success) {
                    process.exitCode = 1;
                    return c.ok(resetResult);
                }
                const workflow = await loadWorkflow(c.args.workflow);
                const abort = setupAbortSignal();
                const runResult = await Effect.runPromise(runWorkflow(workflow, {
                    input: {},
                    runId: c.options.runId,
                    workflowPath: c.args.workflow,
                    resume: true,
                    force: c.options.force,
                    onProgress,
                    signal: abort.signal,
                }));
                process.exitCode = formatStatusExitCode(runResult.status);
                return c.ok({
                    ...resetResult,
                    status: runResult.status,
                    error: runResult.error,
                });
            }
            finally {
                cleanup?.();
            }
        }
        catch (err) {
            return fail({ code: "RETRY_TASK_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers timetravel <workflow>
    // =========================================================================
.command("timetravel", {
    description: "Time-travel to a previous task state by reverting filesystem state, resetting DB state, and optionally resuming.",
    args: workflowArgs,
    options: z.object({
        runId: z.string().describe("Run ID"),
        nodeId: z.string().describe("Task/node ID to travel back to"),
        iteration: z.number().int().default(0).describe("Loop iteration"),
        attempt: z.number().int().optional().describe("Attempt number (default: latest)"),
        vcs: z.boolean().default(true).describe("Revert filesystem state. Use --no-vcs to skip (DB only)."),
        deps: z.boolean().default(true).describe("Also reset dependents. Use --no-deps to reset only this node."),
        resume: z.boolean().default(false).describe("Resume the workflow after time travel"),
        force: z.boolean().default(false).describe("Force even if run is still running"),
    }),
    alias: { runId: "r", nodeId: "n", attempt: "a" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
            try {
                const run = await adapter.getRun(c.options.runId);
                if (run?.status === "running" && !c.options.force) {
                    return fail({
                        code: "RUN_STILL_RUNNING",
                        message: `Run ${c.options.runId} is still marked running. Re-run with --force to time-travel it anyway.`,
                        exitCode: 4,
                    });
                }
                const result = await timeTravel(adapter, {
                    runId: c.options.runId,
                    nodeId: c.options.nodeId,
                    iteration: c.options.iteration,
                    attempt: c.options.attempt,
                    resetDependents: c.options.deps,
                    restoreVcs: c.options.vcs,
                    onProgress: (e) => console.log(JSON.stringify(e)),
                });
                if (!result.success || !c.options.resume) {
                    process.exitCode = result.success ? 0 : 1;
                    return c.ok(result);
                }
                process.stderr.write(`[smithers] Time travel reset ${result.resetNodes.join(", ")} on run ${c.options.runId}\n`);
                if (result.vcsRestored && result.jjPointer) {
                    process.stderr.write(`[smithers] VCS state restored to ${result.jjPointer}\n`);
                }
                process.stderr.write(`[smithers] Resuming run...\n`);
                const workflow = await loadWorkflow(c.args.workflow);
                const onProgress = buildProgressReporter();
                const abort = setupAbortSignal();
                const runResult = await Effect.runPromise(runWorkflow(workflow, {
                    input: {},
                    runId: c.options.runId,
                    workflowPath: c.args.workflow,
                    resume: true,
                    force: true,
                    onProgress,
                    signal: abort.signal,
                }));
                process.exitCode = formatStatusExitCode(runResult.status);
                return c.ok({
                    ...result,
                    resumed: true,
                    status: runResult.status,
                });
            }
            finally {
                cleanup?.();
            }
        }
        catch (err) {
            return fail({ code: "TIMETRAVEL_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers observability
    // =========================================================================
    .command("observability", {
    description: "Start the local observability stack (Grafana, Prometheus, Tempo, OTLP Collector) via Docker Compose.",
    options: z.object({
        detach: z.boolean().default(false).describe("Run containers in the background"),
        down: z.boolean().default(false).describe("Stop and remove the observability stack"),
    }),
    alias: { detach: "d" },
    async run(c) {
        const fail = makeFail(c);
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const composeDirCandidates = [
            resolve(moduleDir, "../../observability"),
            resolve(moduleDir, "../../../observability"),
        ];
        const composeDir = composeDirCandidates.find((dir) => existsSync(resolve(dir, "docker-compose.otel.yml"))) ?? composeDirCandidates[0];
        const composeFile = resolve(composeDir, "docker-compose.otel.yml");
        if (!existsSync(composeFile)) {
            return fail({
                code: "COMPOSE_NOT_FOUND",
                message: [
                    `Docker Compose file not found. Checked ${composeDirCandidates.map((dir) => resolve(dir, "docker-compose.otel.yml")).join(", ")}.`,
                    `Reinstall smithers-orchestrator or upgrade @smithers-orchestrator/observability to a version that ships the local stack assets, then run "smithers observability --detach".`,
                    `Docker with Compose support is required.`,
                ].join(" "),
                exitCode: 1,
            });
        }
        const composeArgs = [
            "compose", "-f", composeFile,
            ...(c.options.down ? ["down"] : ["up", ...(c.options.detach ? ["-d"] : [])]),
        ];
        process.stderr.write(c.options.down
            ? `[smithers] Stopping observability stack...\n`
            : `[smithers] Starting observability stack...\n` +
                `  Grafana:    http://localhost:3001\n` +
                `  Prometheus: http://localhost:9090\n` +
                `  Tempo:      http://localhost:3200\n`);
        const child = spawn("docker", composeArgs, { stdio: "inherit", cwd: composeDir });
        const result = await new Promise((resolve) => {
            child.on("close", (code) => resolve({ exitCode: code ?? 0 }));
            child.on("error", (err) => {
                process.stderr.write(`Failed to run docker compose: ${err.message}\n`);
                process.stderr.write(`Make sure Docker is installed and running.\n`);
                resolve({ exitCode: 1 });
            });
        });
        process.exitCode = result.exitCode;
        return c.ok({ action: c.options.down ? "down" : "up", exitCode: result.exitCode });
    },
})
    // =========================================================================
    // smithers ask <question>
    // =========================================================================
    .command("ask", {
    description: "Ask a question about Smithers using your installed agent and the Smithers MCP server.",
    args: z.object({
        question: z.string().optional().describe("The question to ask"),
    }),
    options: z.object({
        agent: z.enum(["claude", "codex", "antigravity", "kimi", "pi"]).optional().describe("Explicitly select which agent CLI to use"),
        listAgents: z.boolean().default(false).describe("List detected agents plus their bootstrap mode and exit"),
        dumpPrompt: z.boolean().default(false).describe("Print the generated system prompt and exit"),
        toolSurface: z.enum(["semantic", "raw"]).default("semantic").describe("Choose which Smithers MCP tool surface to expose"),
        mcp: z.boolean().default(true).describe("Bootstrap the Smithers MCP server. Use --no-mcp for prompt-only fallback."),
        printBootstrap: z.boolean().default(false).describe("Print the selected bootstrap configuration and exit"),
    }),
    async run(c) {
        try {
            await ask(c.args.question, process.cwd(), { ...c.options, noMcp: !c.options.mcp });
            return c.ok(undefined);
        }
        catch (err) {
            commandExitOverride = 1;
            return c.error({
                code: "ASK_FAILED",
                message: err?.message ?? String(err),
            });
        }
    },
})
    // =========================================================================
    // smithers scores <run_id>
    // =========================================================================
    .command("scores", {
    description: "View scorer results for a specific run.",
    args: z.object({ runId: z.string().describe("Run ID to inspect") }),
    options: z.object({
        node: z.string().optional().describe("Filter scores to a specific node ID"),
    }),
    async run(c) {
        const fail = makeFail(c);
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const results = await adapter.listScorerResults(c.args.runId, c.options.node);
                if (!results || results.length === 0) {
                    return c.ok({ scores: [], message: "No scores found for this run." });
                }
                const rows = results.map((r) => ({
                    node: r.nodeId,
                    scorer: r.scorerName,
                    score: typeof r.score === "number" ? r.score.toFixed(2) : String(r.score),
                    reason: r.reason ?? "—",
                    source: r.source,
                }));
                return c.ok({ scores: rows }, {
                    cta: buildAgentNextSteps({ runId: c.args.runId }),
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({ code: "SCORES_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers replay <workflow>
    // =========================================================================
    .command("replay", {
    description: "Fork from a checkpoint and resume execution (time travel).",
    args: workflowArgs,
    options: z.object({
        runId: z.string().describe("Source run ID to replay from"),
        frame: z.number().int().describe("Frame number to fork from"),
        node: z.string().optional().describe("Node ID to reset to pending"),
        input: z.string().optional().describe("Input overrides as JSON string"),
        label: z.string().optional().describe("Branch label for the fork"),
        restoreVcs: z.boolean().default(false).describe("Restore jj filesystem state to the source frame's revision"),
    }),
    alias: { runId: "r", frame: "f", node: "n", input: "i", label: "l" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { replayFromCheckpoint } = await import("@smithers-orchestrator/time-travel/replay");
            const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
            try {
                const parsedOverrides = tryParseJsonInput(c.options.input, "input");
                if (!parsedOverrides.ok)
                    return fail(parsedOverrides.error);
                const inputOverrides = parsedOverrides.value;
                const resetNodes = c.options.node ? [c.options.node] : undefined;
                const resolvedReplayWorkflowPath = resolve(c.args.workflow);
                const result = await replayFromCheckpoint(adapter, {
                    parentRunId: c.options.runId,
                    frameNo: c.options.frame,
                    inputOverrides,
                    resetNodes,
                    branchLabel: c.options.label,
                    restoreVcs: c.options.restoreVcs,
                    // Re-bless durable metadata to the workflow being replayed so a
                    // replay that carries an edited workflow resumes (mirrors `fork`);
                    // otherwise the resume guard rejects it with RESUME_METADATA_MISMATCH.
                    workflowPath: resolvedReplayWorkflowPath,
                    workflowHash: await readWorkflowGraphHash(resolvedReplayWorkflowPath),
                    entryWorkflowHash: await readWorkflowEntryHash(resolvedReplayWorkflowPath),
                });
                reportReplayResult({
                    result,
                    parentRunId: c.options.runId,
                    parentFrame: c.options.frame,
                });
                // Now resume the forked run
                process.stderr.write(`[smithers] Resuming forked run...\n`);
                const workflow = await loadWorkflow(c.args.workflow);
                const onProgress = buildProgressReporter();
                const abort = setupAbortSignal();
                const engine = await import("@smithers-orchestrator/engine");
                const runResult = await Effect.runPromise(engine.runWorkflow(workflow, {
                    input: {},
                    runId: result.runId,
                    workflowPath: c.args.workflow,
                    resume: true,
                    force: true,
                    onProgress,
                    signal: abort.signal,
                }));
                process.exitCode = formatStatusExitCode(runResult.status);
                return c.ok({
                    forkedRunId: result.runId,
                    parentRunId: c.options.runId,
                    parentFrame: c.options.frame,
                    vcsRestored: result.vcsRestored,
                    status: runResult.status,
                }, {
                    cta: buildAgentNextSteps({
                        workflowId: workflowIdFromPath(c.args.workflow),
                        workflowFile: c.args.workflow,
                        runId: result.runId,
                    }),
                });
            }
            finally {
                cleanup?.();
            }
        }
        catch (err) {
            return fail({ code: "REPLAY_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers tree <runId>
    // =========================================================================
    .command("tree", {
    description: "Print DevTools snapshot as XML tree.",
    args: z.object({
        runId: z.string().describe("Run ID to inspect"),
    }),
    options: z.object({
        frame: z.number().int().min(0).optional().describe("Historical frame number"),
        watch: z.boolean().default(false).describe("Stream live events"),
        json: z.boolean().default(false).describe("Emit snapshot JSON"),
        depth: z.number().int().min(1).optional().describe("Truncate depth"),
        node: z.string().optional().describe("Scope to subtree"),
        color: z.enum(["auto", "always", "never"]).default("auto").describe("Colorize output"),
    }),
    // Finding #3: --json collides with incur's format flag. Expose -j as
    // a command-scoped alias; rewriteDevtoolsJsonFlagArgv() in main()
    // rewrites raw `--json` → `-j` for these commands so it lands as a
    // command option, not a format directive.
    // -w matches --watch on ps/events/inspect/node. (#10)
    alias: { json: "j", watch: "w" },
    run(c) {
        return runDevtoolsCommandWithTelemetry("tree", c, async (io) => {
            const { runTreeOnce, runTreeWatch } = await import("./tree.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const color = resolveCliColor(c.options.color, process.stdout);
                if (c.options.watch) {
                    const abort = new AbortController();
                    const onSignal = () => abort.abort();
                    process.once("SIGINT", onSignal);
                    process.once("SIGTERM", onSignal);
                    try {
                        const result = await runTreeWatch({
                            adapter,
                            runId: c.args.runId,
                            frameNo: c.options.frame,
                            node: c.options.node,
                            depth: c.options.depth,
                            json: c.options.json,
                            watch: true,
                            color,
                            stdout: io.stdout,
                            stderr: io.stderr,
                            abortSignal: abort.signal,
                        });
                        return result.exitCode;
                    } finally {
                        process.off("SIGINT", onSignal);
                        process.off("SIGTERM", onSignal);
                    }
                }
                const result = await runTreeOnce({
                    adapter,
                    runId: c.args.runId,
                    frameNo: c.options.frame,
                    node: c.options.node,
                    depth: c.options.depth,
                    json: c.options.json,
                    watch: false,
                    color,
                    stdout: io.stdout,
                    stderr: io.stderr,
                });
                if (result.exitCode === 0 && !c.options.json && !c.formatExplicit)
                    writeAgentNextStepsHuman({ runId: c.args.runId, justRan: "tree" });
                return result.exitCode;
            } finally {
                cleanup();
            }
        });
    },
})
    // =========================================================================
    // smithers diff <runId> <nodeId>
    // =========================================================================
    .command("diff", {
    description: "Print DiffBundle as unified diff.",
    args: z.object({
        runId: z.string().describe("Run ID containing the node"),
        nodeId: z.string().describe("Node ID to diff"),
    }),
    options: z.object({
        iteration: z.number().int().min(0).optional().describe("Loop iteration"),
        json: z.boolean().default(false).describe("Emit raw DiffBundle"),
        stat: z.boolean().default(false).describe("Show stat summary only"),
        color: z.enum(["auto", "always", "never"]).default("auto").describe("Colorize output"),
    }),
    alias: { json: "j" },
    run(c) {
        return runDevtoolsCommandWithTelemetry("diff", c, async (io) => {
            const { runDiffOnce } = await import("./diff.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const color = resolveCliColor(c.options.color, process.stdout);
                const result = await runDiffOnce({
                    adapter,
                    runId: c.args.runId,
                    nodeId: c.args.nodeId,
                    iteration: c.options.iteration,
                    json: c.options.json,
                    stat: c.options.stat,
                    color,
                    stdout: io.stdout,
                    stderr: io.stderr,
                });
                return result.exitCode;
            } finally {
                cleanup();
            }
        });
    },
})
    // =========================================================================
    // smithers output <runId> <nodeId>
    // =========================================================================
    .command("output", {
    description: "Print node output row.",
    args: z.object({
        runId: z.string().describe("Run ID containing the node"),
        nodeId: z.string().describe("Node ID to fetch output for"),
    }),
    options: z.object({
        iteration: z.number().int().min(0).optional().describe("Loop iteration"),
        json: z.boolean().default(true).describe("Emit raw row as JSON"),
        pretty: z.boolean().default(false).describe("Schema-ordered render"),
    }),
    alias: { json: "j" },
    run(c) {
        return runDevtoolsCommandWithTelemetry("output", c, async (io) => {
            const { runOutputOnce } = await import("./output.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const result = await runOutputOnce({
                    adapter,
                    runId: c.args.runId,
                    nodeId: c.args.nodeId,
                    iteration: c.options.iteration,
                    json: c.options.json && !c.options.pretty,
                    pretty: c.options.pretty,
                    stdout: io.stdout,
                    stderr: io.stderr,
                });
                return result.exitCode;
            } finally {
                cleanup();
            }
        });
    },
})
    // =========================================================================
    // smithers rewind <runId> <frameNo>
    // =========================================================================
    .command("rewind", {
    description: "Rewind a run to a previous frame.",
    args: z.object({
        runId: z.string().describe("Run ID to rewind"),
        frameNo: z.coerce.number().int().min(0).describe("Target frame number"),
    }),
    options: z.object({
        yes: z.boolean().default(false).describe("Skip confirmation"),
        json: z.boolean().default(false).describe("Emit JumpResult JSON"),
    }),
    alias: { json: "j" },
    run(c) {
        return runDevtoolsCommandWithTelemetry("rewind", c, async (io) => {
            const { runRewindOnce } = await import("./rewind.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const result = await runRewindOnce({
                    adapter,
                    runId: c.args.runId,
                    frameNo: c.args.frameNo,
                    yes: c.options.yes,
                    json: c.options.json,
                    stdin: process.stdin,
                    stdout: io.stdout,
                    stderr: io.stderr,
                });
                if (result.exitCode === 0 && !c.options.json && !c.formatExplicit)
                    writeAgentNextStepsHuman({ runId: c.args.runId });
                return result.exitCode;
            } finally {
                cleanup();
            }
        });
    },
})
    // =========================================================================
    // smithers fork <workflow>
    // =========================================================================
    .command("fork", {
    description: "Create a branched run from a snapshot checkpoint (time travel).",
    args: workflowArgs,
    options: z.object({
        runId: z.string().describe("Source run ID"),
        frame: z.number().int().describe("Frame number to fork from"),
        resetNode: z.string().optional().describe("Node ID to reset to pending"),
        input: z.string().optional().describe("Input overrides as JSON string"),
        label: z.string().optional().describe("Branch label"),
        run: z.boolean().default(false).describe("Immediately start the forked run"),
    }),
    alias: { runId: "r", frame: "f", resetNode: "n", input: "i", label: "l" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { forkRun } = await import("@smithers-orchestrator/time-travel/fork");
            const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
            try {
                const parsedOverrides = tryParseJsonInput(c.options.input, "input");
                if (!parsedOverrides.ok)
                    return fail(parsedOverrides.error);
                const inputOverrides = parsedOverrides.value;
                const resetNodes = c.options.resetNode ? [c.options.resetNode] : undefined;
                const resolvedForkWorkflowPath = resolve(c.args.workflow);
                const result = await forkRun(adapter, {
                    parentRunId: c.options.runId,
                    frameNo: c.options.frame,
                    inputOverrides,
                    resetNodes,
                    branchLabel: c.options.label,
                    workflowPath: resolvedForkWorkflowPath,
                    workflowHash: await readWorkflowGraphHash(resolvedForkWorkflowPath),
                    entryWorkflowHash: await readWorkflowEntryHash(resolvedForkWorkflowPath),
                });
                process.stderr.write(`[smithers] Forked run ${result.runId} from ${c.options.runId}:${c.options.frame}\n`);
                if (c.options.run) {
                    process.stderr.write(`[smithers] Starting forked run...\n`);
                    const workflow = await loadWorkflow(c.args.workflow);
                    const onProgress = buildProgressReporter();
                    const abort = setupAbortSignal();
                    const engine = await import("@smithers-orchestrator/engine");
                    const runResult = await Effect.runPromise(engine.runWorkflow(workflow, {
                        input: {},
                        runId: result.runId,
                        workflowPath: c.args.workflow,
                        resume: true,
                        force: true,
                        onProgress,
                        signal: abort.signal,
                    }));
                    process.exitCode = formatStatusExitCode(runResult.status);
                    return c.ok({
                        forkedRunId: result.runId,
                        parentRunId: c.options.runId,
                        parentFrame: c.options.frame,
                        started: true,
                        status: runResult.status,
                    }, {
                        cta: buildAgentNextSteps({
                            workflowId: workflowIdFromPath(c.args.workflow),
                            workflowFile: c.args.workflow,
                            runId: result.runId,
                        }),
                    });
                }
                return c.ok({
                    forkedRunId: result.runId,
                    parentRunId: c.options.runId,
                    parentFrame: c.options.frame,
                    started: false,
                }, {
                    cta: withAgentNextSteps({
                        workflowId: workflowIdFromPath(c.args.workflow),
                        workflowFile: c.args.workflow,
                        runId: result.runId,
                    }, [{
                            command: `fork ${c.args.workflow} -r ${c.options.runId} -f ${c.options.frame} --run`,
                            description: "Fork again and start the forked run immediately",
                        }]),
                });
            }
            finally {
                cleanup?.();
            }
        }
        catch (err) {
            return fail({ code: "FORK_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers timeline <run_id>
    // =========================================================================
    .command("timeline", {
    description: "View execution timeline for a run and its forks (time travel).",
    args: z.object({ runId: z.string().describe("Run ID") }),
    options: z.object({
        tree: z.boolean().default(false).describe("Include all child forks recursively"),
        json: z.boolean().default(false).describe("Output as JSON"),
    }),
    alias: { json: "j" },
    async run(c) {
        const fail = makeFail(c);
        try {
            const { buildTimeline, buildTimelineTree, formatTimelineForTui, formatTimelineAsJson } = await import("@smithers-orchestrator/time-travel/timeline");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const tree = c.options.tree
                    ? await buildTimelineTree(adapter, c.args.runId)
                    : { timeline: await buildTimeline(adapter, c.args.runId), children: [] };
                if (c.options.json) {
                    writeStdoutSync(`${JSON.stringify({ timeline: formatTimelineAsJson(tree) }, null, 2)}\n`);
                    return undefined;
                }
                console.log(formatTimelineForTui(tree));
                return c.ok({ timeline: formatTimelineAsJson(tree) }, {
                    cta: buildAgentNextSteps({ runId: c.args.runId }),
                });
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
            return fail({ code: "TIMELINE_FAILED", message: err?.message ?? String(err), exitCode: 1 });
        }
    },
})
    // =========================================================================
    // smithers gui [path]
    // Opens a directory as a workspace in the Smithers Gateway UI.
    // =========================================================================
    .command("gui", {
    description: "Open a directory's workspace in the Smithers UI: starts (or attaches to) the workspace Gateway and opens the MOST RECENT run's workflow UI; pass --workflow <id> to open a specific workflow UI directly.",
    args: z.object({
        path: z.string().optional().describe("Directory path (defaults to current working directory)"),
    }),
    options: z.object({
        gateway: z.string().optional().describe("Gateway base URL (default http://127.0.0.1:<port>)."),
        port: z.number().int().min(1).max(65535).default(7331).describe("Gateway port when --gateway is not set."),
        workflow: z.string().optional().describe("Open this workflow's UI directly, skipping run lookup."),
        open: z.boolean().default(true).describe("Open a browser. Use --no-open to just print the URL."),
        autostart: z.boolean().default(true).describe("If no Gateway is reachable on the local port, start one automatically. Use --no-autostart to disable."),
        daemon: z.boolean().default(true).describe("Allow a background gateway daemon. Use --no-daemon (or SMITHERS_NO_DAEMON=1) to force direct/embedded operation and never autostart one — for CI, sandboxes, and containers."),
    }),
    alias: { gateway: "g", workflow: "w" },
    async run(c) {
        const input = c.args.path ?? process.cwd();
        const target = resolve(input);
        if (!existsSync(target)) {
            return c.error({ code: "PATH_NOT_FOUND", message: `Path does not exist: ${target}`, exitCode: 1 });
        }
        if (!statSync(target).isDirectory()) {
            return c.error({ code: "PATH_NOT_DIRECTORY", message: `Path is not a directory: ${target}`, exitCode: 1 });
        }
        const previousCwd = process.cwd();
        try {
            process.chdir(target);
            return await runUiCommand({ ...c, args: { runId: undefined } });
        }
        finally {
            process.chdir(previousCwd);
        }
    },
})
    // =========================================================================
    // smithers ui [runId]
    // Attach to a previously started run and open its workflow's custom UI in
    // the browser. The Gateway serves workflow UIs at <uiPath> and is the
    // authoritative source for which workflows have one (listWorkflows.uiPath),
    // so this resolves the run -> workflow -> uiPath against a running Gateway
    // and opens <gateway><uiPath>?runId=<runId>.
    // =========================================================================
    .command("ui", {
    description: "Open the custom UI for a workflow run in your browser. Starts a local Gateway automatically if none is running (serving workflow-owned <UI> declarations); pass --no-autostart or --gateway <url> to opt out.",
    args: z.object({
        runId: z.string().optional().describe("Run to open. Defaults to the most recent run."),
    }),
    options: z.object({
        gateway: z.string().optional().describe("Gateway base URL (default http://127.0.0.1:<port>)."),
        port: z.number().int().min(1).max(65535).default(7331).describe("Gateway port when --gateway is not set."),
        workflow: z.string().optional().describe("Open this workflow's UI directly, skipping run lookup."),
        app: z.boolean().default(false).describe("Open the full local Smithers UI (the apps/smithers control surface) instead of a single workflow run UI. Builds the bundle on first use and serves it against the local Gateway."),
        appPort: z.number().int().min(1).max(65535).default(7332).describe("Port to serve the full UI on (with --app)."),
        rebuild: z.boolean().default(false).describe("Force a rebuild of the full UI bundle before serving (with --app)."),
        open: z.boolean().default(true).describe("Open a browser. Use --no-open to just print the URL."),
        autostart: z.boolean().default(true).describe("If no Gateway is reachable on the local port, start one automatically. Use --no-autostart to disable."),
        daemon: z.boolean().default(true).describe("Allow a background gateway daemon. Use --no-daemon (or SMITHERS_NO_DAEMON=1) to force direct/embedded operation and never autostart one — for CI, sandboxes, and containers."),
    }),
    alias: { gateway: "g", workflow: "w" },
    async run(c) {
        return runUiCommand(c);
    },
})
    // =========================================================================
    // smithers monitor
    // Open the Smithers Monitor — the live all-runs web UI the gateway serves
    // at /monitor. Pure observation: unlike the retired monitor workflow, it
    // launches nothing and costs nothing to look at.
    // =========================================================================
    .command("monitor", {
    description: "Open the Smithers Monitor: a live web UI over every run in this workspace (runs, execution trees, events, approvals). Starts the workspace Gateway automatically if none is running; pass --no-autostart or --gateway <url> to opt out.",
    args: z.object({
        runId: z.string().optional().describe("Focus this run when the monitor opens (deep-links ?runId=)."),
    }),
    options: z.object({
        gateway: z.string().optional().describe("Gateway base URL (default http://127.0.0.1:<port>)."),
        port: z.number().int().min(1).max(65535).default(7331).describe("Gateway port when --gateway is not set."),
        open: z.boolean().default(true).describe("Open a browser. Use --no-open to just print the URL."),
        autostart: z.boolean().default(true).describe("If no Gateway is reachable for this workspace, start one automatically. Use --no-autostart to disable."),
        daemon: z.boolean().default(true).describe("Allow a background gateway daemon. Use --no-daemon (or SMITHERS_NO_DAEMON=1) to force direct operation and never autostart one — for CI, sandboxes, and containers."),
    }),
    alias: { gateway: "g" },
    async run(c) {
        return runMonitorCommand(c);
    },
})
    // =========================================================================
    // smithers docs / smithers docs-full
    // Print the llms.txt / llms-full.txt docs for this CLI version by default.
    // =========================================================================
    .command("docs", {
    description: "Print llms.txt (concise docs index for LLMs) for this CLI version.",
    options: z.object({
        latest: z.boolean().default(false).describe("Fetch the latest docs from smithers.sh instead of docs for this CLI version"),
        docsVersion: z.string().optional().describe("Fetch docs for a specific Smithers version, e.g. 0.22.0 or v0.22.0"),
    }),
    async run(c) {
        return printSmithersDocs(c, "llms.txt", "DOCS_FETCH_FAILED");
    },
})
    .command("docs-full", {
    description: "Print llms-full.txt (full docs bundle for LLMs) for this CLI version.",
    options: z.object({
        latest: z.boolean().default(false).describe("Fetch the latest docs from smithers.sh instead of docs for this CLI version"),
        docsVersion: z.string().optional().describe("Fetch docs for a specific Smithers version, e.g. 0.22.0 or v0.22.0"),
    }),
    async run(c) {
        return printSmithersDocs(c, "llms-full.txt", "DOCS_FULL_FETCH_FAILED");
    },
})
    // =========================================================================
    // smithers upgrade
    // Agent-assisted upgrade workflow: TUI for humans, detached run for agents.
    // =========================================================================
    .command("upgrade", {
    description: "Run the agent-assisted Smithers upgrade workflow: fetch changelogs, upgrade with a cheap agent, and escalate to a smart agent only when needed.",
    options: upgradeOptions,
    alias: { detach: "d", runId: "r" },
    outputPolicy: "agent-only",
    async run(c) {
        const fail = makeFail(c);
        let workflow;
        try {
            workflow = resolveWorkflow("upgrade", process.cwd());
        }
        catch (err) {
            const message = err instanceof SmithersError && err.code === "RUN_NOT_FOUND"
                ? "The upgrade workflow is not installed in this .smithers pack. Run `smithers init` to refresh the workflow pack, then re-run `smithers upgrade`."
                : err?.message ?? String(err);
            return fail({
                code: err instanceof SmithersError ? err.code : "UPGRADE_WORKFLOW_NOT_FOUND",
                message,
                exitCode: 4,
            });
        }
        const mode = upgradeLaunchMode(c.options, c.format);
        if (mode === "needs-tty") {
            return fail({
                code: "INTERACTIVE_REQUIRES_TTY",
                message: "--interactive needs an interactive terminal (TTY) and human output; it cannot be combined with --format json/jsonl.",
                exitCode: 4,
            });
        }
        if (mode === "interactive") {
            const runOptions = buildUpgradeUpOptions(c.options, false);
            return runTuiCommand({ ...c, options: { ...runOptions, interactive: true } }, fail, { preselect: workflow });
        }
        return executeUpCommand(c, workflow.entryFile, buildUpgradeUpOptions(c.options, true), fail);
    },
})
    // =========================================================================
    // smithers update
    // Detect how Smithers was installed and either run the upgrade or print it.
    // =========================================================================
    .command("update", {
    description: "Check for a newer Smithers release and upgrade the install (or print how). Workflow packs update via `packs update`.",
    options: z.object({
        check: z.boolean().default(false).describe("Only report current vs latest version; never upgrade"),
        dryRun: z.boolean().default(false).describe("Print the upgrade command without running it"),
    }),
    async run(c) {
        const current = readPackageVersion();
        const [latest, remoteSota] = await Promise.all([fetchLatestVersion({}), fetchRemoteSotaVersion({})]);
        const install = detectInstallMethod();
        if (!latest) {
            process.stderr.write("Could not reach the npm registry to check for updates.\n");
            return c.error({ message: "Could not reach the npm registry to check for updates.", code: "UPDATE_CHECK_FAILED" });
        }
        // The SOTA model registry ships inside each release; a newer remote
        // registry means new best-in-class models are (or are about to be) in.
        const sotaBehind = remoteSota != null && remoteSota > SOTA_REGISTRY_VERSION;
        if (remoteSota != null) {
            process.stderr.write(sotaBehind
                ? `Model registry: v${SOTA_REGISTRY_VERSION} installed, v${remoteSota} published — new SOTA models are out.\n`
                : `Model registry: v${SOTA_REGISTRY_VERSION} (up to date).\n`);
        }
        const available = isUpdateAvailable(latest, current);
        if (!available) {
            process.stderr.write(`Smithers is up to date (${current}).\n`);
            if (sotaBehind) {
                process.stderr.write("The next release carries the new model registry; this notice will nudge again when it ships.\n");
            }
            return c.ok({ current, latest, updateAvailable: false, action: "none", sotaVersion: SOTA_REGISTRY_VERSION, sotaLatest: remoteSota });
        }
        const plan = buildUpdatePlan(install, SMITHERS_PACKAGE);
        process.stderr.write(`Smithers ${latest} is available (you have ${current}).\n`);
        process.stderr.write(`${plan.explanation}\n`);
        if (plan.command) {
            process.stderr.write(`  ${plan.command}\n`);
        }
        // `--check` reports only; a non-runnable plan (bunx/local/unknown) can only
        // ever print guidance; `--dry-run` prints the command but stops short.
        if (c.options.check || c.options.dryRun || !plan.runnable || !plan.command) {
            return c.ok({ current, latest, updateAvailable: true, action: "print", command: plan.command, installKind: install.kind });
        }
        process.stderr.write(`Running: ${plan.command}\n`);
        const [cmd, ...cmdArgs] = plan.command.split(" ");
        const child = spawn(cmd, cmdArgs, { stdio: "inherit" });
        const result = await new Promise((resolve) => {
            child.on("close", (code) => resolve({ exitCode: code ?? 0 }));
            child.on("error", (err) => {
                process.stderr.write(`Failed to run \`${plan.command}\`: ${err.message}\n`);
                process.stderr.write(`Run it yourself, or re-run with \`--dry-run\` to just print it.\n`);
                resolve({ exitCode: 1 });
            });
        });
        if (result.exitCode !== 0) {
            commandExitOverride = result.exitCode;
            return c.error({ message: `Upgrade command exited with code ${result.exitCode}.`, code: "UPDATE_FAILED" });
        }
        process.stderr.write(`✓ Upgraded to ${latest}.\n`);
        if (sotaBehind) {
            process.stderr.write("New SOTA models are in. Run `smithers init` to refresh installed workflows to the latest agents.\n");
        }
        return c.ok({ current, latest, updateAvailable: true, action: "upgraded", command: plan.command, sotaVersion: SOTA_REGISTRY_VERSION, sotaLatest: remoteSota });
    },
})
    .command("usage", {
    description: "Show how much rate limit / subscription quota each registered account has used.",
    options: z.object({
        account: z.string().optional().describe("Only report this account label"),
        provider: z.string().optional().describe("Only report accounts for this provider"),
        fresh: z.boolean().default(false).describe("Bypass the short usage cache (still respects provider rate-limit floors)"),
    }),
    async run(c) {
        let accounts = listAccounts();
        if (c.options.account) {
            accounts = accounts.filter((a) => a.label === c.options.account);
        }
        if (c.options.provider) {
            accounts = accounts.filter((a) => a.provider === c.options.provider);
        }
        const reports = await getUsageForAccounts(accounts, { fresh: c.options.fresh });
        // Human-readable table to stderr; the structured envelope (--format json/toon)
        // goes to stdout, matching `smithers agents list`.
        process.stderr.write(`${formatUsageReports(reports)}\n`);
        return c.ok({ reports });
    },
})
    .command(workflowCli)
    .command(claudeCli)
    .command(cronCli)
    .command(agentsCli)
    .command(memoryCli)
    .command(openapiCli)
    .command(tokenCli)
    .command(worktreeCli);
const cliCommands = Cli.toCommands?.get(cli);
if (!(cliCommands instanceof Map)) {
    throw new Error("Could not resolve Smithers CLI commands for input bounds.");
}
wrapCliCommandHandlersWithInputBounds(cliCommands);
/**
 * Resolve a leaf command entry (with its args/options zod schemas) from a
 * resolved command path such as "inspect" or "workflow run".
 *
 * @param {string} commandPath
 * @returns {{ args?: any; options?: any } | undefined}
 */
function resolveCliCommandEntry(commandPath) {
    /** @type {any} */
    let scope = cliCommands;
    /** @type {any} */
    let entry;
    for (const token of String(commandPath ?? "").trim().split(/\s+/)) {
        if (!(scope instanceof Map) || !scope.has(token)) return undefined;
        entry = scope.get(token);
        scope = entry && typeof entry === "object" && "_group" in entry ? entry.commands : undefined;
    }
    return entry && typeof entry === "object" && !("_group" in entry) ? entry : undefined;
}
/**
 * incur reports missing required inputs with raw zod prose ("Invalid input:
 * expected string, received undefined" plus an embedded Details blob) in its
 * machine envelope. Build an explicit top line ("Missing required argument
 * <runId>" / "Missing required option --run-id" plus a --help pointer) from
 * the normalized fieldErrors instead, mirroring incur's own TTY renderer.
 * Returns undefined when nothing is missing so invalid-value messages (the
 * contract pinned by tests/init.e2e.test.js) pass through untouched. (#12)
 *
 * @param {string} commandPath
 * @param {{ path?: string; missing?: boolean }[]} fieldErrors
 * @returns {string | undefined}
 */
function friendlyMissingInputMessage(commandPath, fieldErrors) {
    const missing = fieldErrors.filter((fieldError) => fieldError?.missing && typeof fieldError.path === "string");
    if (missing.length === 0) return undefined;
    const entry = resolveCliCommandEntry(commandPath);
    const parts = missing.map((fieldError) => {
        const head = String(fieldError.path).split(".")[0];
        if (entry?.options?.shape?.[head]) {
            const kebab = head.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
            return `Missing required option --${kebab}`;
        }
        return `Missing required argument <${fieldError.path}>`;
    });
    const helpCommand = commandPath ? `smithers ${commandPath} --help` : "smithers --help";
    return `${parts.join("; ")}. Run \`${helpCommand}\` for usage.`;
}
// Root middleware: rewrite the VALIDATION_ERROR top line for missing required
// inputs before incur formats the machine envelope. The zod ValidationError is
// thrown inside incur's command execution (before any run handler), so a
// middleware around next() is the only in-repo seam; mutating the message and
// rethrowing preserves the fieldErrors contract and the exit code. (#12)
cli.use(async (c, next) => {
    try {
        return await next();
    }
    catch (error) {
        const fieldErrors = /** @type {any} */ (error)?.fieldErrors;
        if (error instanceof Error && Array.isArray(fieldErrors)) {
            const rewritten = friendlyMissingInputMessage(c.command, fieldErrors);
            if (rewritten) error.message = rewritten;
        }
        // `up` has no --dry-run flag, but agents reach for it (the CLI
        // convention, and sibling verbs `update`/`supervise`, put dry-run there)
        // to validate a workflow before spending tokens. Redirect the bare
        // "Unknown flag: --dry-run" to `smithers graph`, which IS the dry-run
        // path: it renders the graph without executing or persisting anything.
        if (error instanceof Error &&
            c.command === "up" &&
            /Unknown flag:\s*--?dry-run\b/.test(error.message)) {
            error.message =
                "`up` has no --dry-run flag. To validate a workflow's graph without executing it or spending any agent tokens (a dry run), run `smithers graph <workflow>`.";
        }
        throw error;
    }
});
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const KNOWN_COMMANDS = new Set([
    ...cliCommands.keys(),
    "completions",
    "mcp",
    "skills",
]);
/**
 * Common wrong guesses map straight to the right command(s) so an agent or
 * human who types the natural-but-wrong verb gets pointed at the real one
 * instead of a bare "Unknown command".
 *
 * @type {Record<string, string>}
 */
const COMMAND_ALIASES = {
    list: "ps (list runs) or workflow list (list workflows)",
    ls: "ps (list runs)",
    "list-runs": "ps",
    runs: "ps",
    workflows: "workflow list",
    status: "ps",
    stop: "cancel",
    kill: "cancel",
    start: "up",
    exec: "up",
    show: "inspect",
    log: "logs",
    tail: "logs",
    help: "--help",
};
/**
 * Levenshtein edit distance between two strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    let prev = Array.from({ length: cols }, (_, index) => index);
    for (let i = 1; i < rows; i++) {
        const curr = [i];
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = curr;
    }
    return prev[cols - 1];
}
/**
 * Build a "did you mean" hint for an unknown command: prefer an explicit alias,
 * otherwise the closest known command by edit distance (within a small
 * threshold so we never suggest something unrelated).
 *
 * @param {string} command
 * @returns {string | undefined}
 */
function suggestKnownCommand(command) {
    const alias = COMMAND_ALIASES[command];
    if (alias)
        return alias;
    let best;
    let bestDistance = Infinity;
    for (const known of KNOWN_COMMANDS) {
        const distance = editDistance(command, known);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = known;
        }
    }
    // Only suggest when it's a plausible typo, not a wild miss.
    const threshold = command.length <= 4 ? 2 : 3;
    return best && bestDistance <= threshold ? best : undefined;
}
/**
 * Rewrite `smithers .` or `smithers <path>` (when path looks like a directory) to `smithers gui <path>`.
 * Matches the convention of VS Code / Cursor's `code .` shortcut for opening the current directory.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function rewriteGuiShortcutArgv(argv) {
    const firstPositionalIndex = findFirstPositionalIndex(argv);
    if (firstPositionalIndex < 0) return argv;
    const firstPositional = argv[firstPositionalIndex];
    if (KNOWN_COMMANDS.has(firstPositional)) return argv;
    const isDotShortcut = firstPositional === "." || firstPositional === "..";
    const resolved = resolve(firstPositional);
    const isExistingDir = existsSync(resolved) && statSync(resolved).isDirectory();
    if (!isDotShortcut && !isExistingDir) return argv;
    return [
        ...argv.slice(0, firstPositionalIndex),
        "gui",
        ...argv.slice(firstPositionalIndex),
    ];
}
/**
 * Resolve the --color flag to a boolean: auto → process.stdout.isTTY.
 * Honors NO_COLOR when color === "auto" to match Unix conventions.
 *
 * @param {"auto" | "always" | "never" | undefined} mode
 * @param {{ isTTY?: boolean }} stream
 * @returns {boolean}
 */
function resolveCliColor(mode, stream) {
    if (mode === "always") return true;
    if (mode === "never") return false;
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR.length > 0) return false;
    return Boolean(stream.isTTY);
}
const WORKFLOW_UTILITY_COMMANDS = new Set([
    "run",
    "list",
    "path",
    "create",
    "inspect",
    "skills",
    "doctor",
]);
/**
 * @param {string[]} argv
 */
function hasHelpFlag(argv, startIndex = 0) {
    for (let index = startIndex; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--help" || arg === "-h") {
            return true;
        }
    }
    return false;
}
/**
 * @param {string[]} argv
 */
function hasJsonFormatFlag(argv) {
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--format") {
            const value = argv[index + 1];
            if (value === "json" || value === "jsonl") {
                return true;
            }
            index++;
            continue;
        }
        if (arg === "--format=json" || arg === "--format=jsonl") {
            return true;
        }
    }
    return false;
}
/**
 * @param {string[]} argv
 * @param {number} startIndex
 */
function hasJsonFlag(argv, startIndex) {
    for (let index = startIndex; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--json" || arg === "-j") {
            return true;
        }
    }
    return false;
}
/**
 * @param {string[]} argv
 */
function argvRequestsJsonMode(argv) {
    const commandIndex = findFirstPositionalIndex(argv);
    if (commandIndex < 0) {
        return hasJsonFormatFlag(argv);
    }
    const command = argv[commandIndex];
    if (hasJsonFormatFlag(argv)) {
        return true;
    }
    if (command === "why" ||
        command === "events" ||
        command === "inspect" ||
        command === "node" ||
        DEVTOOLS_COMMANDS.has(command)) {
        return hasJsonFlag(argv, commandIndex + 1);
    }
    if (command === "agents") {
        const subcommandIndex = findFirstPositionalIndex(argv, commandIndex + 1);
        return subcommandIndex >= 0 && argv[subcommandIndex] === "doctor" && hasJsonFlag(argv, subcommandIndex + 1);
    }
    if (command === "doctor") {
        return hasJsonFlag(argv, commandIndex + 1);
    }
    return false;
}
/**
 * Some commands own stdout completely and promise a raw JSON document even
 * without `--format json`. Run those before Incur can append framework CTAs
 * such as the stale-skills reminder, which would make stdout unparsable.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
function runRawJsonAgentCommandIfMatched(argv) {
    const positionals = [];
    let jsonOutput = false;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--json") {
            jsonOutput = true;
            continue;
        }
        if (arg === "--format") {
            if (argv[index + 1] !== "json") {
                return false;
            }
            jsonOutput = true;
            index += 1;
            continue;
        }
        if (arg === "--format=json") {
            jsonOutput = true;
            continue;
        }
        if (arg.startsWith("-")) {
            return false;
        }
        positionals.push(arg);
    }
    if (positionals.length !== 2 || positionals[0] !== "agents") {
        return false;
    }
    if (positionals[1] === "capabilities") {
        process.stdout.write(`${JSON.stringify(getCliAgentCapabilityReport(), null, 2)}\n`);
        process.exit(0);
    }
    if (positionals[1] === "doctor" && jsonOutput) {
        const report = getCliAgentCapabilityDoctorReport();
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.exit(report.ok ? 0 : 1);
    }
    return false;
}
/**
 * @param {string[]} argv
 * @returns {Promise<boolean>}
 */
async function runRawJsonTimelineCommandIfMatched(argv) {
    const positionals = [];
    let jsonOutput = false;
    let treeOutput = false;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "-j" || arg === "--json") {
            jsonOutput = true;
            continue;
        }
        if (arg === "--tree") {
            treeOutput = true;
            continue;
        }
        if (arg === "--format") {
            if (argv[index + 1] !== "json") {
                return false;
            }
            jsonOutput = true;
            index += 1;
            continue;
        }
        if (arg === "--format=json") {
            jsonOutput = true;
            continue;
        }
        if (arg.startsWith("-")) {
            return false;
        }
        positionals.push(arg);
    }
    if (!jsonOutput || positionals.length !== 2 || positionals[0] !== "timeline") {
        return false;
    }
    const { buildTimeline, buildTimelineTree, formatTimelineAsJson } = await import("@smithers-orchestrator/time-travel/timeline");
    const { adapter, cleanup } = await findAndOpenDb();
    try {
        const tree = treeOutput
            ? await buildTimelineTree(adapter, positionals[1])
            : { timeline: await buildTimeline(adapter, positionals[1]), children: [] };
        writeStdoutSync(`${JSON.stringify({ timeline: formatTimelineAsJson(tree) }, null, 2)}\n`);
        return true;
    }
    finally {
        cleanup();
    }
}
/**
 * @param {string[]} argv
 */
function rewriteWorkflowCommandArgv(argv) {
    const workflowIndex = findFirstPositionalIndex(argv);
    if (workflowIndex < 0 || argv[workflowIndex] !== "workflow") {
        return argv;
    }
    if (hasHelpFlag(argv, workflowIndex + 1)) {
        return argv;
    }
    const subcommandIndex = findFirstPositionalIndex(argv, workflowIndex + 1);
    if (subcommandIndex < 0) {
        return [
            ...argv.slice(0, workflowIndex + 1),
            "list",
            ...argv.slice(workflowIndex + 1),
        ];
    }
    const subcommand = argv[subcommandIndex];
    if (WORKFLOW_UTILITY_COMMANDS.has(subcommand)) {
        return argv;
    }
    const prefix = argv.slice(0, workflowIndex + 1);
    try {
        const workflow = resolveWorkflow(subcommand, process.cwd());
        return [
            ...prefix,
            "run",
            workflow.id,
            ...argv.slice(subcommandIndex + 1),
        ];
    }
    catch {
        return argv;
    }
}
/**
 * @param {string[]} argv
 */
function rewriteEventsJsonFlagArgv(argv) {
    const commandIndex = findFirstPositionalIndex(argv);
    if (commandIndex < 0 || argv[commandIndex] !== "events") {
        return argv;
    }
    return argv.map((arg) => (arg === "--json" ? "-j" : arg));
}
/**
 * @param {string[]} argv
 */
function rewriteTimelineJsonFlagArgv(argv) {
    const commandIndex = findFirstPositionalIndex(argv);
    if (commandIndex < 0 || argv[commandIndex] !== "timeline") {
        return argv;
    }
    return argv.map((arg, idx) => (idx > commandIndex && arg === "--json" ? "-j" : arg));
}
/**
 * @param {unknown} value
 */
function normalizeResumeOption(value) {
    if (value === false || value === undefined || value === null) {
        return { resume: false, resumeRunId: undefined };
    }
    if (value === true) {
        return { resume: true, resumeRunId: undefined };
    }
    if (typeof value !== "string") {
        return { resume: Boolean(value), resumeRunId: undefined };
    }
    const normalized = value.trim();
    if (normalized === "" || normalized === "false") {
        return { resume: false, resumeRunId: undefined };
    }
    if (normalized === "true" || normalized.startsWith("-")) {
        return { resume: true, resumeRunId: undefined };
    }
    return { resume: true, resumeRunId: normalized };
}
/**
 * @param {string[]} argv
 */
function rewriteChatCreateArgv(argv) {
    const commandIndex = findFirstPositionalIndex(argv);
    if (commandIndex < 0 || argv[commandIndex] !== "chat") {
        return argv;
    }
    const subcommandIndex = findFirstPositionalIndex(argv, commandIndex + 1);
    if (subcommandIndex < 0 || argv[subcommandIndex] !== "create") {
        return argv;
    }
    return [
        ...argv.slice(0, commandIndex),
        "chat-create",
        ...argv.slice(subcommandIndex + 1),
    ];
}
/**
 * Write to stdout synchronously so large outputs are fully flushed before the
 * process exits. incur writes command results via an async `process.stdout.write`
 * and the framework then calls process.exit(); on a pipe the OS buffer is only
 * ~64KB, so anything larger (e.g. `docs-full --json`, whose JSON payload exceeds
 * 64KB) is truncated mid-write. A blocking writeSync — the same approach already
 * used for the ask-human prompt on fd 2 — guarantees every byte lands first.
 * Handles partial writes plus a backpressured (EAGAIN) or closed (EPIPE) pipe.
 * @param {string} s
 */
function writeStdoutSync(s) {
    writeFdSync(1, s);
}
/**
 * @param {string} s
 */
function writeStderrSync(s) {
    writeFdSync(2, s);
}
/**
 * @param {number} fd
 * @param {string} s
 */
function writeFdSync(fd, s) {
    const buf = Buffer.from(s, "utf8");
    let offset = 0;
    while (offset < buf.length) {
        try {
            offset += writeSync(fd, buf, offset, buf.length - offset);
        }
        catch (err) {
            const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
            if (code === "EAGAIN") continue;
            if (code === "EPIPE") return;
            throw err;
        }
    }
}
const JJ_CONFLICT_MARKER = /^(?:<<<<<<<|%%%%%%%|>>>>>>>)(?:\s|$)/m;
/**
 * Bun lazily reads the package.json nearest to its initial cwd when the CLI
 * reaches a dynamic import. A jj-conflicted manifest therefore breaks commands
 * that otherwise need only .smithers/ and the backend DB. Find that manifest
 * without asking Bun's module loader to parse it.
 *
 * @param {string} from
 * @returns {string | undefined}
 */
function findNearestPackageJson(from) {
    let dir = resolve(from);
    while (true) {
        const candidate = resolve(dir, "package.json");
        if (existsSync(candidate))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
/**
 * @param {string} cwd
 * @returns {{ path: string; reason: string } | undefined}
 */
function conflictedWorkspaceManifest(cwd) {
    const path = findNearestPackageJson(cwd);
    if (!path)
        return undefined;
    let source;
    try {
        source = readFileSync(path, "utf8");
    }
    catch {
        return undefined;
    }
    try {
        JSON.parse(source);
        return undefined;
    }
    catch {
        if (!JJ_CONFLICT_MARKER.test(source))
            return undefined;
        return {
            path,
            reason: "contains unresolved jj conflict markers",
        };
    }
}
/**
 * A fallback child starts in the CLI package so Bun initializes module
 * resolution from a valid manifest. Restore the user's logical workspace
 * before command dispatch so DB and .smithers discovery retain their existing
 * behavior without changing the resolver's physical cwd.
 *
 * @returns {boolean}
 */
function restoreManifestFallbackCwd() {
    return cliWorkspace.restoreFromEnv();
}
/**
 * @returns {Promise<boolean>}
 */
async function relaunchForConflictedWorkspaceManifest() {
    const cwd = process.cwd();
    const conflict = conflictedWorkspaceManifest(cwd);
    if (!conflict)
        return false;
    writeStderrSync(`[smithers] Warning: ${conflict.path} ${conflict.reason}; continuing with directory-based workspace detection.\n`);
    const cliEntry = fileURLToPath(import.meta.url);
    const cliPackageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
    const childEnv = Object.fromEntries(Object.entries({
        ...process.env,
        [cliWorkspace.fallbackCwdEnv]: cwd,
    }).filter((entry) => entry[1] !== undefined));
    // Replace the process when Bun exposes Node's execve API. Besides
    // preserving pid/signal semantics for a long-running gateway, this avoids
    // letting the original Bun process perform another lazy resolution from
    // the conflicted cwd while it waits for a child.
    if (typeof process.execve === "function") {
        process.chdir(cliPackageDir);
        process.execve(process.execPath, [process.execPath, cliEntry, ...process.argv.slice(2)], childEnv);
    }
    process.chdir(cliPackageDir);
    const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
        env: childEnv,
        stdio: "inherit",
    });
    const exitCode = await new Promise((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolvePromise(code ?? 1));
    });
    process.exit(exitCode);
}
async function main() {
    const manifestFallback = restoreManifestFallbackCwd();
    if (!manifestFallback && await relaunchForConflictedWorkspaceManifest()) {
        return;
    }
    const rawArgv = process.argv.slice(2);
    let argv = rawArgv.map((arg) => (arg === "-v" ? "--version" : arg));
    argv = rewriteGuiShortcutArgv(argv);
    argv = rewriteChatCreateArgv(argv);
    argv = rewriteWorkflowCommandArgv(argv);
    argv = rewriteEventsJsonFlagArgv(argv);
    argv = rewriteDevtoolsJsonFlagArgv(argv);
    argv = rewriteTimelineJsonFlagArgv(argv);
    if (await runRawJsonTimelineCommandIfMatched(argv)) {
        return;
    }
    if (argvRequestsJsonMode(argv)) {
        setJsonMode(true);
    }
    if (runRawJsonAgentCommandIfMatched(argv)) {
        return;
    }
    validateDevtoolsArgv(argv);
    // Allow running workflow files directly: `smithers workflow.tsx` → `smithers up workflow.tsx`
    const firstPositionalIndex = findFirstPositionalIndex(argv);
    const firstPositional = firstPositionalIndex >= 0 ? argv[firstPositionalIndex] : undefined;
    if (firstPositional &&
        !KNOWN_COMMANDS.has(firstPositional) &&
        firstPositional.endsWith(".tsx")) {
        argv = [
            ...argv.slice(0, firstPositionalIndex),
            "up",
            ...argv.slice(firstPositionalIndex),
        ];
    }
    const commandIndex = findFirstPositionalIndex(argv);
    const command = commandIndex >= 0 ? argv[commandIndex] : undefined;
    if (command && !KNOWN_COMMANDS.has(command)) {
        const suggestion = suggestKnownCommand(command);
        const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : "";
        console.error(`Unknown command: ${command}.${didYouMean} Run 'smithers --help' to list commands.`);
        process.exit(4);
    }
    if (command === "review") {
        const { runReviewCli } = await import("@smithers-orchestrator/review/cli");
        // Forward every arg except the `review` token itself — including any flags
        // that preceded it (e.g. `smithers --help review`), so the review CLI can
        // render its own help instead of eagerly starting a review.
        await runReviewCli([...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)], { command: "smithers review", usageExitCode: 4 });
        return;
    }
    // Self-heal the curated agent skill on a normal human-facing invocation:
    // keep ~/.claude/skills (and Pi) in sync with the bundled skill and evict
    // any retired `smithers-orchestrator` copy. Throttled + best-effort; skipped
    // in CI, non-TTY use, JSON mode, and for completions/version/help so it
    // never mutates agent state or adds noise/latency to scripted use. Opt out with
    // SMITHERS_NO_SKILL_REFRESH=1.
    if (command &&
        command !== "completions" &&
        !process.env.CI &&
        process.stderr.isTTY &&
        !argvRequestsJsonMode(argv) &&
        !argv.includes("--version") &&
        !argv.includes("--help") &&
        !argv.includes("-h")) {
        const refreshNotice = formatRefreshNotice(ensureCuratedSkillsFresh());
        if (refreshNotice) console.error(refreshNotice);
    }
    // A successful `smithers init` installs/refreshes skills, so it must not end
    // with incur's "Skills are out of date → smithers skills add" CTA one line
    // later. incur compares its stored skill hash (~/.local/share/incur/
    // smithers.json) against the current command tree during serve, so re-sync
    // BEFORE serve — and only when a previous `smithers skills add` install
    // exists (readHash + hasInstalledSkills), so this never installs skill files
    // for users who never opted in. Best-effort; honors the same opt-out as the
    // curated refresh.
    if (command === "init" &&
        process.env.SMITHERS_NO_SKILL_REFRESH !== "1" &&
        !argvRequestsJsonMode(argv) &&
        !argv.includes("--help") &&
        !argv.includes("-h")) {
        try {
            if (SyncSkills.readHash("smithers") && SyncSkills.hasInstalledSkills("smithers", {})) {
                await SyncSkills.sync("smithers", cliCommands, { description: CLI_DESCRIPTION });
            }
        }
        catch {
            /* best-effort: a failed incur skill sync never blocks init */
        }
    }
    // Passive "new version available" notice. Hits npm at most once a day (see
    // ensureUpdateCheck) and only on an interactive, human-facing invocation so
    // it never adds latency or noise to scripted/agent/CI use. The `update`
    // command does its own, fresher check, so skip it here. Opt out entirely
    // with SMITHERS_NO_UPDATE_CHECK=1.
    if (command &&
        command !== "completions" &&
        command !== "update" &&
        !process.env.CI &&
        process.stderr.isTTY &&
        !argvRequestsJsonMode(argv) &&
        !argv.includes("--version") &&
        !argv.includes("--help") &&
        !argv.includes("-h")) {
        try {
            const check = await ensureUpdateCheck({ currentVersion: readPackageVersion() });
            const notice = formatUpdateNotice(check, detectInstallMethod());
            if (notice) console.error(notice);
        } catch {
            /* best-effort: a failed update check never blocks a command */
        }
    }
    // `--backend` is a registered option only on up/gateway/workflow.
    // The SMITHERS_MIGRATION_REQUIRED error tells users to run any command with
    // `--backend sqlite`, so lift it into SMITHERS_BACKEND for every other command
    // instead of letting incur reject it as an unknown flag.
    const NATIVE_BACKEND_COMMANDS = new Set(["up", "gateway", "workflow"]);
    if (command && !NATIVE_BACKEND_COMMANDS.has(command)) {
        const lifted = extractBackendFlag(argv);
        argv = lifted.argv;
        if (lifted.backend) {
            process.env.SMITHERS_BACKEND = lifted.backend;
        }
    }
    argv = rewriteBareResumeFlagArgv(argv);
    if (await runMcpModeIfRequested(argv, { cli, version: readPackageVersion() })) {
        return;
    }
    let exitCodeFromServe;
    try {
        await cli.serve(argv, {
            stdout(s) {
                writeStdoutSync(s);
            },
            exit(code) {
                exitCodeFromServe = code;
            },
        });
    }
    catch (err) {
        console.error(err?.message ?? String(err));
        process.exit(1);
    }
    // `mcp add` / `skills add` register Smithers into the agents the underlying
    // framework knows about. Reach the rest — Hermes/OpenClaw (native MCP config)
    // and Pi (skills dir) — as a best-effort supplementary step on success.
    const wiring = parseAgentWiringArgv(argv);
    // incur's `mcp add` / `skills add` doesn't know about Hermes/OpenClaw (native
    // MCP config) or Pi (skills dir). When the user explicitly targets ONLY those
    // agents, incur exits non-zero for the "unknown agent" — but those are exactly
    // the agents wired here, so that failure must not skip our wiring. Once we
    // wire them, the command has succeeded, so clear the spurious exit code.
    const extraIds = wiring?.kind === "skills" ? EXTRA_SKILL_AGENTS : EXTRA_MCP_AGENTS;
    const targetsOnlyExtra = Boolean(wiring?.agents?.length && wiring.agents.every((id) => extraIds.includes(id)));
    const serveSucceeded = exitCodeFromServe === undefined || exitCodeFromServe === 0;
    if (wiring && (serveSucceeded || targetsOnlyExtra)) {
        try {
            const results = wireExtraAgents(wiring);
            for (const r of results) {
                if (r.registered) console.error(`✓ ${r.agent}: ${r.path}`);
                else if (r.installedPlugin) console.error(`✓ ${r.agent}: ${r.path} (plugin installed)`);
                else if (Array.isArray(r.linked) && r.linked.length) console.error(`✓ ${r.agent}: ${r.path} (${r.linked.length} skill${r.linked.length === 1 ? "" : "s"})`);
                else if (r.reason && r.reason !== "not-detected" && r.reason !== "no-source-skills") console.error(`⚠ ${r.agent}: skipped (${r.reason})`);
            }
            // The command targeted only agents incur cannot handle; our wiring is
            // the real work, so a serve failure caused solely by the unknown agent
            // is a success once the wiring step has run.
            if (targetsOnlyExtra && !serveSucceeded) exitCodeFromServe = 0;
        }
        catch (err) {
            console.error(`⚠ Smithers agent wiring skipped: ${err?.message ?? String(err)}`);
        }
    }
    // `mcp add` failed inside the registration helper and we did not recover it
    // via supplementary wiring. The usual cause is a runner that word-split the
    // `bunx smithers-orchestrator --mcp` launch command, leaving the helper to
    // choke on the bare `--mcp` flag. Point the user at the reliable manual path.
    if (wiring?.kind === "mcp" && !serveSucceeded && !targetsOnlyExtra) {
        console.error("");
        console.error(mcpAddFallbackMessage({ agents: wiring.agents }));
    }
    if (exitCodeFromServe !== undefined) {
        const commandIndex = findFirstPositionalIndex(argv);
        const cmd = commandIndex >= 0 ? argv[commandIndex] : undefined;
        const isDevtoolsCmd = Boolean(cmd && DEVTOOLS_COMMANDS.has(cmd));
        const mapped = commandExitOverride !== undefined
            ? commandExitOverride
            : isDevtoolsCmd
                ? exitCodeFromServe
                : exitCodeFromServe === 1
                    ? 4
                    : exitCodeFromServe;
        process.exit(mapped);
    }
    // Incur does not call the `exit` callback on success paths.
    if (commandExitOverride !== undefined) {
        process.exit(commandExitOverride);
    }
    process.exit(process.exitCode ?? 0);
}
/**
 * Shared funnel for fatal CLI errors. Presentation continues to use rawError
 * so adding a reporter here cannot change the CLI's output contract.
 * @param {unknown} err
 */
function reportCliError(err) {
    return {
        error: toSmithersError(err),
        rawError: err,
    };
}
/**
 * Last-resort handler for an error that escaped a pre-serve fast path (the
 * raw-JSON timeline/agent paths, MCP mode) or any other unhandled rejection.
 * Without it `main()` rejects unhandled and Bun prints a raw V8 stack, bypassing
 * the CLI's clean-message + exit-code contract. Emits a JSON error envelope on
 * stdout when JSON output was requested (so machine readers still get a
 * parseable document), else the plain message on stderr, then exits non-zero.
 * @param {unknown} err
 */
function reportFatalCliError(err) {
    const { rawError } = reportCliError(err);
    const rawArgv = process.argv.slice(2);
    const wantsJson = argvRequestsJsonMode(rawArgv) ||
        rawArgv.some((arg) => arg === "--json" || arg === "-j" || arg === "--jsonl");
    const code = rawError instanceof SmithersError ? rawError.code : "UNEXPECTED_ERROR";
    const message = rawError && typeof rawError === "object" && "message" in rawError
        ? String(/** @type {{ message: unknown }} */ (rawError).message)
        : String(rawError);
    if (wantsJson) {
        writeStdoutSync(`${JSON.stringify({ code, message })}\n`);
    }
    else {
        console.error(message);
    }
    process.exit(1);
}
export { cli, formatStatusExitCode, isWaitingStatus, pauseCtas };

if (process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN !== "1") {
    process.on("unhandledRejection", (reason) => {
        reportFatalCliError(reason);
    });
    main().catch(reportFatalCliError);
}

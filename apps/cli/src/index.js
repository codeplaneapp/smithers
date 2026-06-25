#!/usr/bin/env bun
import { setJsonMode } from "./util/logger.ts";
import { ensureCuratedSkillsFresh, formatRefreshNotice } from "./refreshCuratedSkills.js";
import { extractBackendFlag, findFirstPositionalIndex, rewriteBareResumeFlagArgv } from "./argv-utils.js";
import { CLI_JSON_ARGUMENT_MAX_BYTES, parseJsonArgument, tryParseJsonInput } from "./json-args.js";
import { resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { Effect, Fiber } from "effect";
import { Cli, z } from "incur";
import { isRunHeartbeatFresh, runWorkflow, renderFrame, resolveSchema } from "@smithers-orchestrator/engine";
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
import { runFork, runPromise } from "./smithersRuntime.js";
import { trackEvent } from "@smithers-orchestrator/observability/metrics";
import { vcsToolingStatus } from "@smithers-orchestrator/vcs/vcsToolingStatus";
import { revertToAttempt } from "@smithers-orchestrator/time-travel/revert";
import { retryTask } from "@smithers-orchestrator/time-travel/retry-task";
import { timeTravel } from "@smithers-orchestrator/time-travel/timetravel";
import { runSync } from "./smithersRuntime.js";
import { spawn } from "node:child_process";
import { buildAgentAskRequestRow, isHumanRequestPastTimeout, validateHumanRequestValue, waitForHumanAnswer, } from "@smithers-orchestrator/engine/human-requests";
import { SmithersError } from "@smithers-orchestrator/errors";
import { assertMaxBytes, assertMaxStringLength } from "@smithers-orchestrator/db/input-bounds";
import { findAndOpenDb, findSmithersDb } from "./find-db.js";
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
import { detectAvailableAgents } from "./agent-detection.js";
import { listAccounts, removeAccount } from "@smithers-orchestrator/accounts";
import { getUsageForAccounts, formatUsageReports } from "@smithers-orchestrator/usage";
import { runAgentAdd, pingAccount } from "./agent-commands/runAgentAdd.js";
import { agentAddWizard } from "./agent-commands/agentAddWizard.js";
import { getWorkflowFollowUpCtas } from "./workflow-pack.js";
import { discoverWorkflows, resolveWorkflow, createWorkflowFile, renderWorkflowSkill, writeWorkflowSkillFiles, resolvePackDirs, summarizeWorkflowInputSchema, workflowInputJsonSchema } from "./workflows.js";
import {
    assertEvalRunIdsAvailable,
    assertEvalReportWritable,
    buildEvalPlan,
    buildEvalReport,
    evaluateEvalCaseResult,
    loadEvalCases,
    renderEvalPlan,
    renderEvalReport,
    writeEvalReport,
} from "./eval-suite.js";
import { initOptions, runInitCommand } from "./init-command.js";
import { startersArgs, startersOptions, runStartersCommand } from "./starter-gallery-command.js";
import { runTuiCommand } from "./tui.js";
import { optimizeOptions, runOptimizeCommand, withOptimizationArtifactEnv } from "./optimize-command.js";
import { ask } from "./ask.js";
import { runScheduler } from "./scheduler.js";
import { resumeRunDetached } from "./resume-detached.js";
import { resolveLaunchRootDir, parsePersistedRootDir } from "./resolve-root.js";
import { formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, } from "@smithers-orchestrator/agents/cli-capabilities";
import { parseDurationMs, supervisorLoopEffect, } from "./supervisor.js";
import { WATCH_MIN_INTERVAL_MS, runWatchLoop, watchIntervalSecondsToMs, } from "./watch.js";
import { runMcpModeIfRequested } from "./mcp/mcp-mode.js";
import { issueSmithersBrokerToken, parseTokenScopes, readSmithersTokenStore, resolveSmithersActionTokenFromStore, revokeSmithersToken, smithersTokenStorePath, writeSmithersTokenStore, } from "./token-store.js";
import { resolveSmithersDocsSource } from "./docs-command.js";
import { reportReplayResult } from "./reportReplayResult.js";
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
    const abs = resolve(process.cwd(), path);
    mdxPlugin();
    const mod = await import(pathToFileURL(abs).href);
    if (!mod.default)
        throw new SmithersError("WORKFLOW_MISSING_DEFAULT", "Workflow must export default");
    return mod.default;
}
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
const CLI_ARGUMENT_MAX_LENGTH = 4096;
const CLI_IDENTIFIER_MAX_LENGTH = 256;
const CLI_TEXT_ARGUMENT_MAX_LENGTH = 64 * 1024;
const CLI_HANDLER_BOUNDS_WRAPPED = Symbol("smithers.cliHandlerBoundsWrapped");
/**
 * @param {string} path
 * @returns {string}
 */
function cliFieldNameFromPath(path) {
    const trimmed = path.replace(/\[\d+\]/g, "");
    const lastDot = trimmed.lastIndexOf(".");
    return lastDot >= 0 ? trimmed.slice(lastDot + 1) : trimmed;
}
/**
 * @param {string} path
 * @param {string} value
 */
function validateCliStringArgument(path, value) {
    const field = cliFieldNameFromPath(path);
    switch (field) {
        case "runId":
        case "requestId":
        case "correlation":
        case "correlationId":
        case "name":
            assertMaxStringLength(path, value, CLI_IDENTIFIER_MAX_LENGTH);
            return;
        case "workflow":
        case "root":
        case "logDir":
            assertMaxStringLength(path, value, CLI_ARGUMENT_MAX_LENGTH);
            return;
        case "input":
        case "data":
        case "value":
            assertMaxBytes(path, value, CLI_JSON_ARGUMENT_MAX_BYTES);
            return;
        case "prompt":
        case "note":
        case "authToken":
            assertMaxStringLength(path, value, CLI_TEXT_ARGUMENT_MAX_LENGTH);
            return;
        default:
            assertMaxStringLength(path, value, CLI_ARGUMENT_MAX_LENGTH);
    }
}
/**
 * @param {unknown} value
 * @param {string} path
 */
function assertCliArgumentBounds(value, path) {
    if (value === null || value === undefined) {
        return;
    }
    if (typeof value === "string") {
        validateCliStringArgument(path, value);
        return;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            assertCliArgumentBounds(value[index], `${path}[${index}]`);
        }
        return;
    }
    if (typeof value !== "object") {
        return;
    }
    for (const [key, entry] of Object.entries(value)) {
        assertCliArgumentBounds(entry, `${path}.${key}`);
    }
}
/**
 * @param {Map<string, any>} commands
 */
function wrapCliCommandHandlersWithInputBounds(commands) {
    for (const entry of commands.values()) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        if ("_group" in entry) {
            wrapCliCommandHandlersWithInputBounds(entry.commands);
            continue;
        }
        if ("_fetch" in entry) {
            continue;
        }
        if (entry[CLI_HANDLER_BOUNDS_WRAPPED]) {
            continue;
        }
        const originalRun = entry.run;
        if (typeof originalRun !== "function") {
            continue;
        }
        entry.run = function wrappedRun(context) {
            assertCliArgumentBounds(context.args, "args");
            assertCliArgumentBounds(context.options, "options");
            return originalRun.call(this, context);
        };
        entry[CLI_HANDLER_BOUNDS_WRAPPED] = true;
    }
}
/**
 * @param {string | undefined} status
 */
function formatStatusExitCode(status) {
    if (status === "finished")
        return 0;
    if (status === "waiting-approval" ||
        status === "waiting-event" ||
        status === "waiting-timer") {
        return 3;
    }
    if (status === "cancelled")
        return 2;
    return 1;
}
/**
 * @param {string | null | undefined} status
 */
function isWaitingStatus(status) {
    return (status === "waiting-approval" ||
        status === "waiting-event" ||
        status === "waiting-timer");
}
/**
 * CTAs shown when `up` ends in a paused (waiting-*) state, so exit code 3 reads
 * as "awaiting a decision" rather than a failure.
 * @param {string | null | undefined} status
 * @param {string} runId
 */
function pauseCtas(status, runId) {
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
        }, 5000);
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
            const res = await fetch(source.url);
            if (!res.ok) {
                return c.error({
                    code: errorCode,
                    message: `Failed to fetch ${source.url}: HTTP ${res.status}`,
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
        let lastSeq = c.options.since ?? -1;
        if (!includeAncestry && c.options.since === undefined) {
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
                c.options.since !== undefined
                    ? merged.filter((event) => (event.seq ?? -1) > c.options.since)
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
        const isActive = run.status === "running" ||
            run.status === "waiting-approval" ||
            run.status === "waiting-event" ||
            run.status === "waiting-timer";
        if (!c.options.follow || !isActive) {
            return c.ok(undefined, {
                cta: {
                    commands: [{ command: `inspect ${c.args.runId}`, description: "Inspect run state" }],
                },
            });
        }
        let lastWaitingStatus = run.status === "waiting-approval" ||
            run.status === "waiting-event" ||
            run.status === "waiting-timer"
            ? run.status
            : undefined;
        while (true) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const newEvents = await adapter.listEvents(c.args.runId, lastSeq, 200);
            for (const event of newEvents) {
                yield formatLine(event);
                lastSeq = event.seq;
            }
            const currentRun = await adapter.getRun(c.args.runId);
            const currentStatus = currentRun?.status;
            if (currentStatus === "waiting-approval" ||
                currentStatus === "waiting-event" ||
                currentStatus === "waiting-timer") {
                lastWaitingStatus = currentStatus;
            }
            if (currentStatus !== "running" &&
                currentStatus !== "waiting-approval" &&
                currentStatus !== "waiting-event" &&
                currentStatus !== "waiting-timer") {
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
        rows.push({
            id: run.runId,
            workflow: run.workflowName ?? (run.workflowPath ? basename(run.workflowPath) : "—"),
            status: derivedStateToStatus(view.state),
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
        });
    }
    return rows;
}
/**
 * Map a derived RunState to the legacy `status` string surfaced by `smithers ps`.
 * Older consumers (and the dashboard CTA logic) still key off `status`, so a row
 * whose owner is dead must surface as something other than "running".
 *
 * @param {import("@smithers-orchestrator/db/runState").RunStateView["state"]} state
 * @returns {string}
 */
function derivedStateToStatus(state) {
    switch (state) {
        case "succeeded":
            return "finished";
        case "stale":
        case "orphaned":
        case "running":
        case "recovering":
        case "waiting-approval":
        case "waiting-event":
        case "waiting-timer":
        case "failed":
        case "cancelled":
        case "unknown":
            return state;
        default:
            return state;
    }
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
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<InspectSnapshot>}
 */
async function buildInspectSnapshot(adapter, runId) {
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
    };
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
        r.status === "waiting-event") {
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
    return {
        result,
        ctaCommands,
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
    workflow: z.string().describe("Path to a .tsx workflow file"),
});
// `up` accepts an optional workflow path: omit it (or pass --interactive) to pick
// one through the interactive terminal flow instead.
const upArgs = z.object({
    workflow: z.string().optional().describe("Path to a .tsx workflow file (omit with --interactive to pick one)"),
});
const upOptions = z.object({
    detach: z.boolean().default(false).describe("Run in background, print run ID, exit"),
    runId: z.string().optional().describe("Explicit run ID"),
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
    port: z.number().int().min(1).default(7331).describe("HTTP server port (with --serve)"),
    host: z.string().default("127.0.0.1").describe("HTTP server bind address (with --serve)"),
    authToken: z.string().optional().describe("Bearer token for HTTP auth (or set SMITHERS_API_KEY)"),
    metrics: z.boolean().default(true).describe("Expose /metrics endpoint (with --serve)"),
    backend: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Storage backend for workflows using openSmithersBackend"),
});
// Launch the interactive picker + live status card instead of a one-shot run.
// Shared by `up` and `workflow run`; deliberately NOT folded into `upOptions`
// so it does not leak onto `monitor` (which also extends `upOptions`).
const interactiveRunOption = z
    .boolean()
    .default(false)
    .describe("Pick a workflow and its inputs through interactive terminal prompts, then live-render the run (TTY only)");
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
});
const superviseOptions = z.object({
    dryRun: z.boolean().default(false).describe("Show which stale runs would be resumed, without acting"),
    interval: z.string().default("10s").describe("Poll interval (e.g. 10s, 30s, 1m)"),
    staleThreshold: z.string().default("30s").describe("Heartbeat staleness threshold before resume"),
    maxConcurrent: z.number().int().min(1).default(3).describe("Max runs resumed per poll"),
});
const gatewayOptions = z.object({
    host: z.string().default("127.0.0.1").describe("Gateway bind address"),
    port: z.number().int().min(1).default(7331).describe("Gateway port"),
    backend: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Workspace storage backend"),
    authToken: z.string().optional().describe("Bearer token for HTTP/WS auth (or set SMITHERS_API_KEY); required to bind a non-loopback --host"),
    insecure: z.boolean().default(false).describe("Allow binding a non-loopback --host with NO auth (exposes a full-control, unauthenticated control plane — dangerous)"),
});
const migrateOptions = z.object({
    from: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Source backend; inferred when exactly one store has runs"),
    to: z.enum(["sqlite", "pglite", "postgres"]).optional().describe("Target backend; required (pglite, postgres, or sqlite)"),
    url: z.string().optional().describe("Postgres connection URL when --to postgres"),
    keepSqlite: z.boolean().default(true).describe("Keep the legacy SQLite database after a successful copy"),
    agent: z.boolean().default(false).describe("Run the durable migrate-repair workflow instead of deterministic migration"),
});
const monitorArgs = z.object({
    runId: z.string().optional().describe("Run ID to monitor (default: the most recent active run)"),
});
const monitorOptions = upOptions.extend({
    autofix: z.boolean().default(false).describe("Let the monitor apply the smallest safe self-fix and resume the run"),
    requireApproval: z.boolean().default(true).describe("With --autofix, pause for a human approval gate before any fix"),
    staleMinutes: z.number().default(15).describe("Treat a non-terminal run idle past this many minutes as stuck"),
    ui: z.boolean().default(true).describe("Auto-open the monitored run's own custom UI in the browser when its workflow has one (use --no-ui to skip)"),
});
const psOptions = z.object({
    status: z.string().optional().describe("Filter by status: running, waiting-approval, waiting-event, waiting-timer, continued, finished, failed, cancelled"),
    limit: z.number().int().min(1).default(20).describe("Maximum runs to return"),
    all: z.boolean().default(false).describe("Include all statuses"),
    watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
    interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
});
const logsOptions = z.object({
    follow: z.boolean().default(true).describe("Keep tailing (default true for active runs)"),
    since: z.number().int().optional().describe("Start from event sequence number"),
    tail: z.number().int().min(1).default(50).describe("Show last N events first"),
    followAncestry: z.boolean().default(false).describe("Include events from ancestor runs (continuation lineage)"),
});
const eventsOptions = z.object({
    node: z.string().optional().describe("Filter events by node ID"),
    type: z.string().optional().describe(`Filter by event category (${[...EVENT_CATEGORY_VALUES].sort().join(", ")})`),
    since: z.string().optional().describe("Filter to a recent duration window (e.g. 5m, 2h)"),
    limit: z.number().int().min(1).optional().describe("Maximum events to display (default 1000, max 100000)"),
    json: z.boolean().default(false).describe("Output NDJSON for piping"),
    groupBy: z.string().optional().describe("Group output by \"node\" or \"attempt\""),
    watch: z.boolean().default(false).describe("Watch mode: append new events as they arrive"),
    interval: z.number().positive().default(2).describe("Watch poll interval in seconds"),
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
    agent: z.enum(["claude-code", "codex", "antigravity"]).describe("CLI agent engine to launch"),
    cwd: z.string().optional().describe("Working directory for the chat session (default: current directory)"),
});
const inspectArgs = z.object({
    runId: z.string().describe("Run ID to inspect"),
});
const inspectOptions = z.object({
    watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
    interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
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
const approveArgs = z.object({
    runId: z.string().describe("Run ID containing the approval gate"),
});
const approveOptions = z.object({
    node: z.string().optional().describe("Node ID (required if multiple pending)"),
    iteration: z.number().int().min(0).default(0).describe("Loop iteration number"),
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
const hijackArgs = z.object({
    runId: z.string().describe("Run ID whose latest agent session should be hijacked"),
});
const hijackOptions = z.object({
    target: z.string().optional().describe("Expected agent engine (claude-code or codex)"),
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
const workflowCreateOptions = z.object({
    global: z.boolean().default(false).describe("Create the workflow in the global ~/.smithers pack (honors SMITHERS_HOME) instead of the local .smithers"),
});
const workflowRunOptions = upOptions.extend({
    prompt: z.string().optional().describe("Prompt text mapped to input.prompt when --input is omitted"),
    interactive: interactiveRunOption,
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
 * @param {{ interactive?: boolean }} options
 * @param {boolean} hasWorkflowArg
 * @returns {"interactive" | "direct" | "needs-tty" | "missing-arg"}
 */
function interactiveLaunchMode(options, hasWorkflowArg) {
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (options.interactive) return tty ? "interactive" : "needs-tty";
    if (!hasWorkflowArg) return tty ? "interactive" : "missing-arg";
    return "direct";
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
 * @param {string} workflowInput
 */
function resolveWorkflowPathForEval(workflowInput) {
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
    try {
        const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
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
        const { resume, resumeRunId } = normalizeResumeOption(options.resume);
        const runId = options.runId ?? resumeRunId;
        // Detached mode: spawn ourselves as a background process
        if (options.detach) {
            const cliPath = fileURLToPath(import.meta.url);
            const childArgs = ["up", workflowPath];
            if (runId)
                childArgs.push("--run-id", runId);
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
            if (options.supervise)
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
            const logFileDir = options.logDir ?? dirname(resolvedWorkflowPath);
            const effectiveRunId = runId ?? `run-${Date.now()}`;
            const logFile = resolve(logFileDir, `${effectiveRunId}.log`);
            if (!runId)
                childArgs.push("--run-id", effectiveRunId);
            const fd = openSync(logFile, "a");
            const child = spawn("bun", [cliPath, ...childArgs], {
                detached: true,
                stdio: ["ignore", fd, fd],
                env: process.env,
            });
            child.unref();
            return c.ok({ runId: effectiveRunId, logFile, pid: child.pid }, {
                cta: {
                    description: "Next steps:",
                    commands: [
                        { command: `logs ${effectiveRunId}`, description: "Tail run logs" },
                        { command: `chat ${effectiveRunId} --follow`, description: "Watch agent chat" },
                        { command: `ps`, description: "List all runs" },
                        { command: `inspect ${effectiveRunId}`, description: "Inspect run state" },
                    ],
                },
            });
        }
        if (options.hot) {
            process.env.SMITHERS_HOT = "1";
        }
        if (options.backend) {
            process.env.SMITHERS_BACKEND = options.backend;
        }
        if (options.supervise && !options.serve) {
            return fail({
                code: "SUPERVISE_REQUIRES_SERVE",
                message: "--supervise on `smithers up` requires --serve. Use `smithers supervise` for standalone mode.",
                exitCode: 4,
            });
        }
        if (Boolean(options.resumeClaimOwner) !== Boolean(options.resumeClaimHeartbeat)) {
            return fail({
                code: "INVALID_RESUME_CLAIM",
                message: "--resume-claim-owner and --resume-claim-heartbeat must be provided together.",
                exitCode: 4,
            });
        }
        const workflow = await loadWorkflow(workflowPath);
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
                process.stderr.write(`⚠ Found ${staleRuns.length} run(s) still marked as 'running':\n`);
                for (const r of staleRuns) {
                    process.stderr.write(`  ${r.runId} (started ${new Date(r.startedAtMs ?? r.createdAtMs).toISOString()})\n`);
                }
                process.stderr.write("  Use 'smithers cancel' to mark them as cancelled, or 'smithers up --resume' to continue.\n");
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
            const { createServeApp } = await import("@smithers-orchestrator/server/serve");
            const effectiveRunId = runId ?? `run-${Date.now()}`;
            const serveApp = createServeApp({
                workflow: workflow,
                adapter: adapter,
                runId: effectiveRunId,
                abort,
                authToken: options.authToken ?? process.env.SMITHERS_API_KEY,
                metrics: options.metrics,
            });
            const bunServer = Bun.serve({
                port: options.port,
                hostname: options.host,
                fetch: serveApp.fetch,
            });
            process.stderr.write(`[smithers] HTTP server listening on http://${options.host}:${bunServer.port}\n`);
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
                resume,
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
            process.exitCode = formatStatusExitCode(result.status);
            return c.ok(result, {
                cta: result.runId ? {
                    description: isWaitingStatus(result.status)
                        ? "Run is paused (exit 3 = awaiting a decision, not a failure). Next steps:"
                        : "Next steps:",
                    commands: [
                        ...pauseCtas(result.status, result.runId),
                        ...getWorkflowFollowUpCtas(workflowPath),
                        { command: `inspect ${result.runId}`, description: "Inspect run state" },
                        { command: `logs ${result.runId}`, description: "View run logs" },
                        { command: `chat ${result.runId}`, description: "View agent chat" },
                    ],
                } : undefined,
            });
        }
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input,
            runId,
            resume,
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
        process.exitCode = formatStatusExitCode(result.status);
        return c.ok(result, {
            cta: result.runId ? {
                description: isWaitingStatus(result.status)
                    ? "Run is paused (exit 3 = awaiting a decision, not a failure). Next steps:"
                    : "Next steps:",
                commands: [
                    ...pauseCtas(result.status, result.runId),
                    ...getWorkflowFollowUpCtas(workflowPath),
                    { command: `inspect ${result.runId}`, description: "Inspect run state" },
                    { command: `logs ${result.runId}`, description: "View run logs" },
                    { command: `chat ${result.runId}`, description: "View agent chat" },
                ],
            } : undefined,
        });
    }
    catch (err) {
        return fail({ code: "RUN_FAILED", message: err?.message ?? String(err), exitCode: 1 });
    }
}
/**
 * @param {{ host: string; port: number; backend?: "sqlite" | "pglite" | "postgres" }} options
 * @returns {Promise<{ url: string; workspace: string; dbPath: string; workflows: string[] }>}
 */
function titleizeWorkflowId(id) {
    return id
        .replace(/[-_:]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
}
// Start a local Gateway (the `smithers gateway` command) detached and wait for
// it to answer /health. Used by `smithers ui` so launching a UI is one command.
async function autoStartGateway(port) {
    const host = "127.0.0.1";
    const base = `http://${host}:${port}`;
    try {
        const child = spawn(process.argv[0], [process.argv[1], "gateway", "--host", host, "--port", String(port)], {
            stdio: "ignore",
            detached: true,
        });
        child.unref();
        child.on("error", () => { });
    }
    catch {
        return false;
    }
    // Gateway boot loads + compiles every workspace workflow before it listens,
    // so allow generous time for /health to come up.
    for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const ok = await fetch(`${base}/health`).then((res) => res.ok, () => false);
        if (ok)
            return true;
    }
    return false;
}
async function runUiCommand(c) {
    const base = (c.options.gateway ?? `http://127.0.0.1:${c.options.port}`).replace(/\/+$/, "");
    const fail = (code, message) => c.error({ code, message, exitCode: 1 });
    let reachable = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    if (!reachable && c.options.autostart && !c.options.gateway) {
        process.stderr.write(`[smithers] No Gateway at ${base}; starting one (smithers gateway --port ${c.options.port})…\n`);
        reachable = await autoStartGateway(c.options.port);
    }
    if (!reachable) {
        return fail("GATEWAY_UNREACHABLE", `No Smithers Gateway reachable at ${base}. Start one with \`smithers gateway\` (it serves workspace UIs from .smithers/ui/), or pass --gateway <url> to point at a running one. Note: \`smithers up --serve\` is a per-run server, not a full Gateway.`);
    }
    const rpc = async (method, params = {}) => {
        const res = await fetch(`${base}/v1/rpc/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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
    const openInBrowser = (url) => {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
        const proc = spawn(cmd, args, { stdio: "ignore", detached: true });
        proc.unref();
        proc.on("error", () => { });
    };
    try {
        const workflows = await rpc("listWorkflows", {});
        const byKey = new Map((Array.isArray(workflows) ? workflows : []).map((w) => [w.key, w]));
        let workflowKey = c.options.workflow;
        let runId = c.args.runId;
        if (!workflowKey) {
            if (!runId) {
                const runs = await rpc("listRuns", {});
                const latest = Array.isArray(runs) ? runs[0] : undefined;
                if (!latest) {
                    return fail("NO_RUNS", "No runs found. Start one with `smithers up` or `smithers workflow <name>`.");
                }
                runId = latest.runId ? String(latest.runId) : undefined;
                workflowKey = latest.workflowKey ? String(latest.workflowKey) : undefined;
            }
            if (!workflowKey && runId) {
                const run = await rpc("getRun", { runId });
                workflowKey = run?.workflowKey ? String(run.workflowKey) : undefined;
            }
        }
        if (!workflowKey) {
            return fail("WORKFLOW_UNRESOLVED", runId ? `Could not resolve a workflow for run ${runId}.` : "Could not resolve a workflow to open.");
        }
        const summary = byKey.get(workflowKey);
        if (!summary || !summary.hasUi || !summary.uiPath) {
            return fail("NO_UI", `Workflow "${workflowKey}" has no UI mounted on the Gateway at ${base}.`);
        }
        const url = `${base}${summary.uiPath}${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`;
        if (c.options.open) openInBrowser(url);
        console.log(`${c.options.open ? "Opening" : "UI URL:"} ${url}`);
        return c.ok({ opened: c.options.open, url, runId: runId ?? null, workflow: workflowKey });
    }
    catch (err) {
        return fail("UI_OPEN_FAILED", err?.message ?? String(err));
    }
}
const GATEWAY_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

async function runGatewayCommand(options) {
    // The Gateway control plane can launch/cancel/inspect EVERY run in the
    // workspace. Without an auth config it authenticates every request as
    // role=operator scopes=["*"]. Refuse to publish that to the network: a
    // non-loopback bind requires a token (or an explicit --insecure override).
    const authToken = options.authToken ?? process.env.SMITHERS_API_KEY;
    const isLoopback = GATEWAY_LOOPBACK_HOSTS.has(options.host);
    if (!isLoopback && !authToken && !options.insecure) {
        throw new SmithersError("GATEWAY_INSECURE_BIND", `Refusing to bind the Gateway to non-loopback host "${options.host}" without authentication — this would expose a full-control, unauthenticated control plane to the network. Set --auth-token <token> (or SMITHERS_API_KEY), bind to 127.0.0.1, or pass --insecure to override.`, { host: options.host });
    }
    const auth = authToken
        ? { mode: "token", tokens: { [authToken]: { role: "operator", scopes: ["*"] } } }
        : undefined;
    const localPackDir = resolvePackDirs(process.cwd()).find((dir) => dir.scope === "local")?.packDir;
    const localWorkspace = localPackDir ? dirname(localPackDir) : undefined;
    const dbPath = localWorkspace
        ? resolve(localWorkspace, "smithers.db")
        : findSmithersDb(process.cwd());
    const workspace = localWorkspace ?? dirname(dbPath);
    process.chdir(workspace);
    if (options.backend) {
        process.env.SMITHERS_BACKEND = options.backend;
    }
    const [{ Gateway }, { openSmithersBackend }] = await Promise.all([
        import("@smithers-orchestrator/server/gateway"),
        import("smithers-orchestrator"),
    ]);
    const gateway = new Gateway({ heartbeatMs: 15_000, ...(auth ? { auth } : {}) });
    const workspaceApi = await openSmithersBackend({}, {
        backend: options.backend,
        cwd: workspace,
        dbPath,
    });
    const workspaceWorkflow = workspaceApi.smithers(() => React.createElement(workspaceApi.Workflow, { name: "workspace" }));
    ensureSmithersTables(workspaceWorkflow.db);
    setupSqliteCleanup(workspaceWorkflow);
    const workflows = [];
    for (const discovered of discoverWorkflows(workspace)) {
        try {
            const workflow = await loadWorkflow(discovered.entryFile);
            ensureSmithersTables(workflow.db);
            setupSqliteCleanup(workflow);
            // Auto-mount a custom UI when the workspace provides
            // .smithers/ui/<id>.tsx, so `smithers gateway` serves workflow UIs
            // without requiring a hand-written .smithers/gateway.ts.
            const uiEntry = resolve(workspace, ".smithers", "ui", `${discovered.id}.tsx`);
            if (existsSync(uiEntry)) {
                gateway.register(discovered.id, workflow, {
                    ui: { entry: uiEntry, title: titleizeWorkflowId(discovered.id) },
                });
            }
            else {
                gateway.register(discovered.id, workflow);
            }
            workflows.push(discovered.id);
        }
        catch (error) {
            process.stderr.write(`[smithers] Skipping workflow ${discovered.id}: ${error?.message ?? String(error)}\n`);
        }
    }
    if (workflows.length === 0) {
        gateway.register("workspace", workspaceWorkflow);
        workflows.push("workspace");
    }
    const server = await gateway.listen({ host: options.host, port: options.port });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : options.port;
    const url = `http://${options.host}:${port}`;
    process.stderr.write(`[smithers] Gateway listening on ${url}\n`);
    process.stderr.write(`[smithers] Workspace: ${workspace}\n`);
    process.stderr.write(`[smithers] Database: ${dbPath}\n`);
    process.stderr.write(`[smithers] Registered workflows: ${workflows.join(", ")}\n`);
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
            }, 5000);
            if (typeof deadline.unref === "function")
                deadline.unref();
            gateway.close()
                .catch((error) => {
                process.stderr.write(`[smithers] Gateway shutdown error: ${error?.message ?? String(error)}\n`);
            })
                .then(() => workspaceApi.close?.())
                .catch((error) => {
                process.stderr.write(`[smithers] Backend shutdown error: ${error?.message ?? String(error)}\n`);
            })
                .finally(resolvePromise);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const mode = interactiveLaunchMode(c.options, Boolean(c.args.name));
            if (mode === "needs-tty") {
                return fail({ code: "INTERACTIVE_REQUIRES_TTY", message: "--interactive needs an interactive terminal (TTY).", exitCode: 4 });
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
    description: "List discovered local workflows.",
    run(c) {
        return c.ok({
            workflows: discoverWorkflows(process.cwd()),
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            return c.ok(createWorkflowFile(c.args.name, process.cwd(), { global: c.options.global }));
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
        });
    },
})
    .command("skills", {
    description: "Generate agent-facing skill docs for local workflows.",
    args: workflowSkillArgs,
    options: workflowSkillOptions,
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const workflowId = c.args.name ?? "all";
            const workflows = workflowId === "all"
                ? discoverWorkflows(process.cwd()).filter((workflow) => workflow.id !== "workflow-skill")
                : [resolveWorkflow(workflowId, process.cwd())];
            const inputSchemas = new Map();
            for (const workflow of workflows) {
                const loaded = await loadWorkflow(workflow.entryFile);
                inputSchemas.set(workflow.id, summarizeWorkflowInputSchema(workflowInputJsonSchema(loaded.inputSchema)));
            }
            return c.ok(writeWorkflowSkillFiles(process.cwd(), {
                workflowId,
                output: c.options.output,
                force: c.options.force,
                global: c.options.global,
                inputSchemas,
            }));
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
// ---------------------------------------------------------------------------
// smithers memory ...
// ---------------------------------------------------------------------------
const memoryListArgs = z.object({
    namespace: z.string().describe("Namespace to list facts for (e.g. 'workflow:my-flow')"),
});
const memoryListOptions = z.object({
    workflow: z.string().describe("Path to a .tsx workflow file"),
});
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
        try {
            const { createMemoryStore } = await import("@smithers-orchestrator/memory/store");
            const { parseNamespace } = await import("@smithers-orchestrator/memory/types");
            const workflow = await loadWorkflowAsync(c.options.workflow);
            ensureSmithersTables(workflow.db);
            setupSqliteCleanup(workflow);
            const store = createMemoryStore(workflow.db);
            const ns = parseNamespace(c.args.namespace);
            const facts = await store.listFacts(ns);
            if (facts.length === 0) {
                console.log(`No facts found in namespace "${c.args.namespace}".`);
                return c.ok({ facts: [], namespace: c.args.namespace });
            }
            for (const f of facts) {
                const value = f.valueJson.length > 100 ? f.valueJson.slice(0, 100) + "..." : f.valueJson;
                const age = formatAge(f.updatedAtMs);
                console.log(`  ${pc.bold(f.key)} = ${value}  ${pc.dim(`(${age})`)}`);
            }
            return c.ok({ facts, namespace: c.args.namespace });
        }
        catch (err) {
            console.error(`Error: ${err?.message ?? String(err)}`);
            return c.error({ code: "MEMORY_LIST_FAILED", message: err?.message ?? String(err) });
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
        try {
            const { createMemoryStore } = await import("@smithers-orchestrator/memory/store");
            const { parseNamespace } = await import("@smithers-orchestrator/memory/types");
            const workflow = await loadWorkflowAsync(c.options.workflow);
            ensureSmithersTables(workflow.db);
            setupSqliteCleanup(workflow);
            const store = createMemoryStore(workflow.db);
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
            const { createMemoryStore } = await import("@smithers-orchestrator/memory/store");
            const { parseNamespace } = await import("@smithers-orchestrator/memory/types");
            const workflow = await loadWorkflowAsync(c.options.workflow);
            ensureSmithersTables(workflow.db);
            setupSqliteCleanup(workflow);
            const store = createMemoryStore(workflow.db);
            await store.setFact(parseNamespace(c.args.namespace), c.args.key, c.args.value, c.options.ttl);
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
            const { createMemoryStore } = await import("@smithers-orchestrator/memory/store");
            const { parseNamespace } = await import("@smithers-orchestrator/memory/types");
            const workflow = await loadWorkflowAsync(c.options.workflow);
            ensureSmithersTables(workflow.db);
            setupSqliteCleanup(workflow);
            const store = createMemoryStore(workflow.db);
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
/**
 * @param {string} fromDir
 * @param {string} targetPath
 * @returns {string}
 */
function relativeImportPath(fromDir, targetPath) {
    const rel = relative(fromDir, targetPath).split("\\").join("/");
    return rel.startsWith(".") ? rel : `./${rel}`;
}
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
            const importPath = relativeImportPath(outputDir, specPath);
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
 * Wrap the inner handler of a devtools command in structured telemetry.
 *
 * - Writes a JSON line to stderr when `SMITHERS_LOG_JSON=1` is set
 *   containing `{ cmd, runId, flags, durationMs, exitCode }`.
 * - Emits an `smithers_cli_command_total{cmd,exit}` counter and a
 *   `smithers_cli_command_duration_ms{cmd}` histogram via the
 *   observability package.
 * @param {"tree"|"diff"|"output"|"rewind"|"snapshots"|"restore"} cmd
 * @param {{ args: any; options: any }} c
 * @param {() => Promise<number>} handler
 */
async function* runDevtoolsCommandWithTelemetry(cmd, c, handler) {
    const startedAt = Date.now();
    let exitCode = 0;
    try {
        exitCode = await handler();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
            : cmd === "rewind"
                ? []
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
 * `smithers monitor [runId]` resolves the bundled `monitor` workflow, folds the
 * monitor-specific flags + the optional target run id into its input, and runs
 * it through the same machinery as `up` (detach, serve, hot, resume all work).
 *
 * @param {any} c
 * @param {FailFn} fail
 */
async function runMonitorCommand(c, fail) {
    let workflowPath;
    try {
        workflowPath = resolveWorkflow("monitor", process.cwd()).entryFile;
    }
    catch {
        return fail({
            code: "MONITOR_WORKFLOW_NOT_FOUND",
            message: "The 'monitor' workflow is not installed. Run `smithers init` to install the workflow pack, or author .smithers/workflows/monitor.tsx.",
            exitCode: 4,
        });
    }
    // Merge any explicit --input with the monitor flags and the positional run id.
    let baseInput = {};
    if (c.options.input) {
        try {
            const parsed = parseJsonArgument(c.options.input, "input");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                baseInput = parsed;
            }
        }
        catch (err) {
            return fail({
                code: err instanceof SmithersError ? err.code : "INVALID_JSON",
                message: err?.message ?? String(err),
                exitCode: 4,
            });
        }
    }
    const merged = { ...baseInput };
    // Resolve the target run id up front: this is the run we watch AND the run
    // whose own custom UI we auto-open. Passing it explicitly also makes the
    // workflow deterministic instead of re-resolving the latest run itself.
    let targetRunId = c.args.runId ?? (typeof merged.targetRunId === "string" ? merged.targetRunId : undefined);
    if (!targetRunId) {
        targetRunId = await resolveLatestRunId();
    }
    if (targetRunId)
        merged.targetRunId = targetRunId;
    if (c.options.autofix)
        merged.autofix = true;
    if (c.options.requireApproval === false)
        merged.requireApproval = false;
    if (c.options.staleMinutes !== undefined && c.options.staleMinutes !== 15)
        merged.staleMinutes = c.options.staleMinutes;
    // Auto-open the monitored run's OWN custom UI (e.g. monitoring a `vcs` run
    // pops open the vcs UI). Reuses `smithers ui`, which autostarts a persistent
    // Gateway and resolves run -> workflow -> uiPath; a workflow with no UI just
    // fails softly inside `ui`. Skipped for machine (JSON) output or --no-ui.
    if (c.options.ui && targetRunId && c.format !== "json") {
        openMonitoredRunUi(targetRunId, c.options.port);
    }
    const options = { ...c.options, input: JSON.stringify(merged) };
    return executeUpCommand(c, workflowPath, options, fail);
}
/**
 * Resolve the most recent active run id from the nearest DB (else the most
 * recent run of any status). Returns undefined when nothing is found.
 *
 * @returns {Promise<string | undefined>}
 */
async function resolveLatestRunId() {
    try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
            const runs = await adapter.listRuns(20);
            if (!Array.isArray(runs) || runs.length === 0)
                return undefined;
            const terminal = new Set(["finished", "completed", "failed", "cancelled", "succeeded"]);
            const active = runs.find((r) => !terminal.has(String(r.status ?? "").toLowerCase()));
            const pick = active ?? runs[0];
            return pick?.runId ? String(pick.runId) : undefined;
        }
        finally {
            cleanup();
        }
    }
    catch {
        return undefined;
    }
}
/**
 * Open the monitored run's own workflow UI by spawning `smithers ui <runId>` in
 * the background. Best-effort: never lets UI opening fail the monitor.
 *
 * @param {string} runId
 * @param {number} [port]
 */
function openMonitoredRunUi(runId, port) {
    try {
        const cliPath = fileURLToPath(import.meta.url);
        const args = [cliPath, "ui", runId];
        if (port && port !== 7331)
            args.push("--port", String(port));
        const child = spawn("bun", args, { stdio: "inherit", detached: true });
        child.unref();
        child.on("error", () => { });
    }
    catch {
        // best-effort: a UI that can't open must not break monitoring
    }
}
// ---------------------------------------------------------------------------
let commandExitOverride;
const cli = Cli.create({
    name: "smithers",
    description: "Durable AI workflow orchestrator. Run, monitor, and manage workflow executions.",
    version: readPackageVersion(),
    mcp: { command: "bunx smithers-orchestrator --mcp" },
})
    // =========================================================================
    // smithers init
    // =========================================================================
    .command("init", {
    description: "Install the local Smithers workflow pack into .smithers/.",
    options: initOptions,
    // The interactive run narrates its own progress + next steps; suppress the
    // raw result dump in a human TTY while keeping full JSON for piped/agent use.
    outputPolicy: "agent-only",
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        return runInitCommand(c, fail);
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        return runStartersCommand(c, fail);
    },
})
    // =========================================================================
    // smithers up [workflow]
    // =========================================================================
    .command("up", {
    description: "Start a workflow execution. Omit the workflow (or pass --interactive) to pick one interactively; use -d for detached (background) mode.",
    args: upArgs,
    options: upRunOptions,
    alias: { detach: "d", runId: "r", input: "i", maxConcurrency: "c" },
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        const mode = interactiveLaunchMode(c.options, Boolean(c.args.workflow));
        if (mode === "needs-tty") {
            return fail({ code: "INTERACTIVE_REQUIRES_TTY", message: "--interactive needs an interactive terminal (TTY).", exitCode: 4 });
        }
        if (mode === "missing-arg") {
            return fail({ code: "WORKFLOW_REQUIRED", message: "Provide a workflow file path, or pass --interactive to pick one.", exitCode: 4 });
        }
        if (mode === "interactive") {
            let preselect;
            if (c.args.workflow) {
                const entryFile = resolve(process.cwd(), c.args.workflow);
                if (!existsSync(entryFile)) {
                    return fail({ code: "WORKFLOW_NOT_FOUND", message: `Workflow file not found: ${c.args.workflow}`, exitCode: 4 });
                }
                const id = basename(c.args.workflow).replace(/\.[mc]?[tj]sx?$/i, "");
                preselect = { entryFile, id, displayName: id };
            }
            return runTuiCommand(c, fail, { preselect });
        }
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                return fail({
                    code: "MIGRATION_AGENT_REQUIRED",
                    message: `Deterministic migration repair guidance is available from smithers migrate errors. Agent-assisted migration repair is tracked as a follow-up and is not available in this build; no migrate-repair workflow is installed. Run deterministic migration with:\n  smithers migrate --from ${c.options.from ?? "<source>"} --to ${c.options.to}${c.options.url ? ` --url ${c.options.url}` : ""}`,
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
    // smithers monitor [runId]
    // =========================================================================
    .command("monitor", {
    description: "Watch, diagnose, optionally self-fix, and HTML-report on a running workflow (runs the `monitor` workflow).",
    args: monitorArgs,
    options: monitorOptions,
    alias: { detach: "d", input: "i", autofix: "f" },
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        return runMonitorCommand(c, fail);
    },
})
    // =========================================================================
    // smithers gateway
    // =========================================================================
    .command("gateway", {
    description: "Serve the multi-run Gateway RPC/WS control plane for the workspace DB; unlike up --serve, this is not tied to one run.",
    options: gatewayOptions,
    alias: { host: "H", port: "p" },
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const workflowPath = resolveWorkflowPathForEval(c.args.workflow);
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
                if (wantsStructured) {
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
                    const evaluation = evaluateEvalCaseResult(testCase, {
                        ...result,
                        output,
                    });
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
                    const evaluation = evaluateEvalCaseResult(testCase, {
                        status: "error",
                        error: err,
                    });
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
            if (wantsStructured) {
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
            resolveWorkflowPathForEval,
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
    description: "Watch for stale running runs and auto-resume them.",
    options: superviseOptions,
    alias: { dryRun: "n", interval: "i", staleThreshold: "t", maxConcurrent: "c" },
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const { adapter, cleanup } = await findAndOpenDb();
        const abort = setupAbortSignal();
        process.stderr.write(`[smithers] Supervisor started (interval=${parsed.pollIntervalMs}ms, staleThreshold=${parsed.staleThresholdMs}ms, maxConcurrent=${parsed.maxConcurrent}, dryRun=${parsed.dryRun})\n`);
        try {
            await runPromise(supervisorLoopEffect({
                adapter,
                dryRun: parsed.dryRun,
                pollIntervalMs: parsed.pollIntervalMs,
                staleThresholdMs: parsed.staleThresholdMs,
                maxConcurrent: parsed.maxConcurrent,
            }), { signal: abort.signal });
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                return c.ok({ runs: rows }, ctaCommands.length > 0 ? { cta: { commands: ctaCommands } } : undefined);
            }
            finally {
                cleanup();
            }
        }
        catch (err) {
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
    description: "Query run event history with filters, grouping, and NDJSON output.",
    args: z.object({ runId: z.string().describe("Run ID to query") }),
    options: eventsOptions,
    alias: { node: "n", type: "t", since: "s", limit: "l", json: "j", watch: "w", interval: "i" },
    async *run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                await new Promise((resolve) => setTimeout(resolve, 500));
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
            const workflow = await buildInlineChatWorkflow(c.options.agent, chatCwd);
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
                cta: {
                    description: "Next steps:",
                    commands: [
                        { command: `hijack ${result.runId}`, description: "Open the chat session" },
                        { command: `inspect ${result.runId}`, description: "Inspect run state" },
                    ],
                },
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                const event = {
                    type: "RunHijackRequested",
                    runId: c.args.runId,
                    timestampMs: requestedAtMs,
                    ...(c.options.target ? { target: c.options.target } : {}),
                };
                await adapter.requestRunHijack(c.args.runId, requestedAtMs, c.options.target ?? null);
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
            if (c.options.target && candidate.engine !== c.options.target) {
                return fail({
                    code: "HIJACK_TARGET_MISMATCH",
                    message: `Run ${c.args.runId} is resumable in ${candidate.engine}, not ${c.options.target}. Cross-engine hijack is not supported.`,
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
    description: "Output detailed run state, including steps, agents, approvals, and outputs.",
    args: inspectArgs,
    options: inspectOptions,
    alias: { watch: "w", interval: "i" },
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                        fetch: () => buildInspectSnapshot(adapter, c.args.runId),
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
                const snapshot = await buildInspectSnapshot(adapter, c.args.runId);
                return c.ok(snapshot.result, { cta: { commands: snapshot.ctaCommands } });
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                    cta: {
                        commands: [
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
                        ],
                    },
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                    cta: {
                        commands: diagnosisCtaCommands(diagnosis),
                    },
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
    // smithers human inbox|answer|cancel
    // =========================================================================
    .command("human", {
    description: "List and resolve durable human requests.",
    args: humanArgs,
    options: humanOptions,
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                const alertId = c.args.alertId?.trim();
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const pending = await adapter.listPendingApprovals(c.args.runId);
                if (pending.length === 0) {
                    return fail({ code: "NO_PENDING_APPROVALS", message: `No pending approvals for run: ${c.args.runId}`, exitCode: 4 });
                }
                let nodeId = c.options.node;
                if (!nodeId) {
                    if (pending.length > 1) {
                        const nodeList = pending.map((a) => `  ${a.nodeId} (iteration ${a.iteration})`).join("\n");
                        return fail({
                            code: "AMBIGUOUS_APPROVAL",
                            message: `Multiple pending approvals. Specify --node:\n${nodeList}`,
                            exitCode: 4,
                        });
                    }
                    nodeId = pending[0].nodeId;
                }
                await Effect.runPromise(approveNode(adapter, c.args.runId, nodeId, c.options.iteration, c.options.note, c.options.by));
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
                return c.ok({
                    runId: c.args.runId,
                    nodeId,
                    status: "approved",
                    ...(isDetached
                        ? { note: `Approval recorded. If running detached, resume the run to continue: smithers workflow run --resume ${c.args.runId}` }
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const pending = await adapter.listPendingApprovals(c.args.runId);
                if (pending.length === 0) {
                    return fail({ code: "NO_PENDING_APPROVALS", message: `No pending approvals for run: ${c.args.runId}`, exitCode: 4 });
                }
                let nodeId = c.options.node;
                if (!nodeId) {
                    if (pending.length > 1) {
                        const nodeList = pending.map((a) => `  ${a.nodeId} (iteration ${a.iteration})`).join("\n");
                        return fail({
                            code: "AMBIGUOUS_APPROVAL",
                            message: `Multiple pending approvals. Specify --node:\n${nodeList}`,
                            exitCode: 4,
                        });
                    }
                    nodeId = pending[0].nodeId;
                }
                await Effect.runPromise(denyNode(adapter, c.args.runId, nodeId, c.options.iteration, c.options.note, c.options.by));
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
                if (run.status !== "running" &&
                    run.status !== "waiting-approval" &&
                    run.status !== "waiting-event" &&
                    run.status !== "waiting-timer") {
                    return fail({ code: "RUN_NOT_ACTIVE", message: `Run is not active (status: ${run.status})`, exitCode: 4 });
                }
                // A live engine in another process is driving this run. A bare
                // status flip is invisible to it: it only observes cancellation
                // by polling `cancel_requested_at_ms` (its cancelWatcher), and on
                // completion it overwrites status with "finished", clobbering our
                // "cancelled". Set the durable cancel request so the engine aborts
                // its agents and writes the terminal cancelled status itself.
                if (run.status === "running" && isRunHeartbeatFresh(run)) {
                    await adapter.requestRunCancel(c.args.runId, Date.now());
                    process.exitCode = 2;
                    return c.ok({
                        runId: c.args.runId,
                        status: "cancel-requested",
                    }, {
                        cta: {
                            commands: [
                                { command: `logs ${c.args.runId} -f`, description: "Watch the run stop" },
                                { command: `ps`, description: "List all runs" },
                            ],
                        },
                    });
                }
                const inProgress = await adapter.listInProgressAttempts(c.args.runId);
                const allAttempts = await adapter.listAttemptsForRun(c.args.runId);
                const now = Date.now();
                for (const attempt of inProgress) {
                    await adapter.updateAttempt(c.args.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                        state: "cancelled",
                        finishedAtMs: now,
                    });
                }
                const waitingTimers = allAttempts.filter((attempt) => attempt.state === "waiting-timer");
                for (const attempt of waitingTimers) {
                    await adapter.updateAttempt(c.args.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                        state: "cancelled",
                        finishedAtMs: now,
                    });
                }
                const nodes = await adapter.listNodes(c.args.runId);
                for (const node of nodes.filter((n) => n.state === "waiting-timer")) {
                    await adapter.insertNode({
                        runId: c.args.runId,
                        nodeId: node.nodeId,
                        iteration: node.iteration ?? 0,
                        state: "cancelled",
                        lastAttempt: node.lastAttempt ?? null,
                        updatedAtMs: now,
                        outputTable: node.outputTable ?? "",
                        label: node.label ?? null,
                    });
                }
                await adapter.updateRun(c.args.runId, { status: "cancelled", finishedAtMs: now });
                process.exitCode = 2;
                return c.ok({
                    runId: c.args.runId,
                    status: "cancelled",
                    cancelledAttempts: inProgress.length + waitingTimers.length,
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
    // smithers down
    // =========================================================================
    .command("down", {
    description: "Cancel all active runs. Like 'docker compose down' for workflows.",
    options: z.object({
        force: z.boolean().default(false).describe("Cancel runs even if they still appear live (default only cancels stale runs)"),
    }),
    async run(c) {
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const activeRuns = await adapter.listRuns(100, "running");
                const waitingApprovalRuns = await adapter.listRuns(100, "waiting-approval");
                const waitingEventRuns = await adapter.listRuns(100, "waiting-event");
                const waitingTimerRuns = await adapter.listRuns(100, "waiting-timer");
                const allActive = [
                    ...activeRuns,
                    ...waitingApprovalRuns,
                    ...waitingEventRuns,
                    ...waitingTimerRuns,
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
                    // A live run reached here only via --force. Request a durable
                    // cancel so the engine aborts itself, rather than a bare status
                    // flip it would overwrite with "finished" on completion. Stale
                    // (dead-engine) and suspended waiting-* runs fall through to the
                    // direct flip below, which is correct as no engine is polling.
                    if (run.status === "running" && isRunHeartbeatFresh(run)) {
                        await adapter.requestRunCancel(run.runId, now);
                        process.stderr.write(`⊘ Cancel requested (live): ${run.runId}\n`);
                        cancelled++;
                        continue;
                    }
                    const inProgress = await adapter.listInProgressAttempts(run.runId);
                    const attempts = await adapter.listAttemptsForRun(run.runId);
                    for (const attempt of inProgress) {
                        await adapter.updateAttempt(run.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                            state: "cancelled",
                            finishedAtMs: now,
                        });
                    }
                    for (const attempt of attempts.filter((entry) => entry.state === "waiting-timer")) {
                        await adapter.updateAttempt(run.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                            state: "cancelled",
                            finishedAtMs: now,
                        });
                    }
                    await adapter.updateRun(run.runId, { status: "cancelled", finishedAtMs: now });
                    process.stderr.write(`⊘ Cancelled: ${run.runId}\n`);
                    cancelled++;
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const resolvedWorkflowPath = resolve(process.cwd(), c.args.workflow);
            const workflow = await loadWorkflow(c.args.workflow);
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
            })));
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
        return runDevtoolsCommandWithTelemetry("snapshots", c, async () => {
            const { runSnapshotsOnce } = await import("./snapshots.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const result = await runSnapshotsOnce({
                    adapter,
                    runId: c.args.runId,
                    json: c.options.json,
                    stdout: c.options.json ? { write: writeStdoutSync } : process.stdout,
                });
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
        return runDevtoolsCommandWithTelemetry("restore", c, async () => {
            const { runRestoreOnce } = await import("./restore.js");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                const result = await runRestoreOnce({
                    adapter,
                    runId: c.args.runId,
                    nodeId: c.args.nodeId,
                    iteration: c.options.iteration,
                    seq: c.options.seq,
                    stdout: process.stdout,
                    stderr: process.stderr,
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
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
                return c.ok({ scores: rows });
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const { replayFromCheckpoint } = await import("@smithers-orchestrator/time-travel/replay");
            const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
            try {
                const parsedOverrides = tryParseJsonInput(c.options.input, "input");
                if (!parsedOverrides.ok)
                    return fail(parsedOverrides.error);
                const inputOverrides = parsedOverrides.value;
                const resetNodes = c.options.node ? [c.options.node] : undefined;
                const result = await replayFromCheckpoint(adapter, {
                    parentRunId: c.options.runId,
                    frameNo: c.options.frame,
                    inputOverrides,
                    resetNodes,
                    branchLabel: c.options.label,
                    restoreVcs: c.options.restoreVcs,
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
    // Findings #1, #2, #3, #7, #11 addressed here.
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
    alias: { json: "j" },
    run(c) {
        return runDevtoolsCommandWithTelemetry("tree", c, async () => {
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
                            stdout: process.stdout,
                            stderr: process.stderr,
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
                    stdout: process.stdout,
                    stderr: process.stderr,
                });
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
        return runDevtoolsCommandWithTelemetry("diff", c, async () => {
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
                    stdout: process.stdout,
                    stderr: process.stderr,
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
        return runDevtoolsCommandWithTelemetry("output", c, async () => {
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
                    stdout: process.stdout,
                    stderr: process.stderr,
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
        return runDevtoolsCommandWithTelemetry("rewind", c, async () => {
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
                    stdout: process.stdout,
                    stderr: process.stderr,
                });
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const { forkRun } = await import("@smithers-orchestrator/time-travel/fork");
            const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
            try {
                const parsedOverrides = tryParseJsonInput(c.options.input, "input");
                if (!parsedOverrides.ok)
                    return fail(parsedOverrides.error);
                const inputOverrides = parsedOverrides.value;
                const resetNodes = c.options.resetNode ? [c.options.resetNode] : undefined;
                const result = await forkRun(adapter, {
                    parentRunId: c.options.runId,
                    frameNo: c.options.frame,
                    inputOverrides,
                    resetNodes,
                    branchLabel: c.options.label,
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
                    });
                }
                return c.ok({
                    forkedRunId: result.runId,
                    parentRunId: c.options.runId,
                    parentFrame: c.options.frame,
                    started: false,
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
        const fail = (opts) => {
            commandExitOverride = opts.exitCode ?? 1;
            return c.error(opts);
        };
        try {
            const { buildTimeline, buildTimelineTree, formatTimelineForTui, formatTimelineAsJson } = await import("@smithers-orchestrator/time-travel/timeline");
            const { adapter, cleanup } = await findAndOpenDb();
            try {
                if (c.options.tree) {
                    const tree = await buildTimelineTree(adapter, c.args.runId);
                    if (c.options.json) {
                        writeStdoutSync(`${JSON.stringify({ timeline: formatTimelineAsJson(tree) }, null, 2)}\n`);
                        return undefined;
                    }
                    else {
                        console.log(formatTimelineForTui(tree));
                    }
                    return c.ok({ timeline: formatTimelineAsJson(tree) });
                }
                const timeline = await buildTimeline(adapter, c.args.runId);
                const tree = { timeline, children: [] };
                if (c.options.json) {
                    writeStdoutSync(`${JSON.stringify({ timeline: formatTimelineAsJson(tree) }, null, 2)}\n`);
                    return undefined;
                }
                else {
                    console.log(formatTimelineForTui(tree));
                }
                return c.ok({ timeline: formatTimelineAsJson(tree) });
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
    description: "Open a directory as a workspace in Smithers UI",
    args: z.object({
        path: z.string().optional().describe("Directory path (defaults to current working directory)"),
    }),
    options: z.object({
        gateway: z.string().optional().describe("Gateway base URL (default http://127.0.0.1:<port>)."),
        port: z.number().int().min(1).max(65535).default(7331).describe("Gateway port when --gateway is not set."),
        workflow: z.string().optional().describe("Open this workflow's UI directly, skipping run lookup."),
        open: z.boolean().default(true).describe("Open a browser. Use --no-open to just print the URL."),
        autostart: z.boolean().default(true).describe("If no Gateway is reachable on the local port, start one automatically. Use --no-autostart to disable."),
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
    description: "Open the custom UI for a workflow run in your browser. Starts a local Gateway automatically if none is running (serving workspace UIs from .smithers/ui/); pass --no-autostart or --gateway <url> to opt out.",
    args: z.object({
        runId: z.string().optional().describe("Run to open. Defaults to the most recent run."),
    }),
    options: z.object({
        gateway: z.string().optional().describe("Gateway base URL (default http://127.0.0.1:<port>)."),
        port: z.number().int().min(1).max(65535).default(7331).describe("Gateway port when --gateway is not set."),
        workflow: z.string().optional().describe("Open this workflow's UI directly, skipping run lookup."),
        open: z.boolean().default(true).describe("Open a browser. Use --no-open to just print the URL."),
        autostart: z.boolean().default(true).describe("If no Gateway is reachable on the local port, start one automatically. Use --no-autostart to disable."),
    }),
    alias: { gateway: "g", workflow: "w" },
    async run(c) {
        return runUiCommand(c);
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
    .command(cronCli)
    .command(agentsCli)
    .command(memoryCli)
    .command(openapiCli)
    .command(tokenCli);
const cliCommands = Cli.toCommands?.get(cli);
if (!(cliCommands instanceof Map)) {
    throw new Error("Could not resolve Smithers CLI commands for input bounds.");
}
wrapCliCommandHandlersWithInputBounds(cliCommands);
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
const CHAT_CREATE_PROMPT = [
    "Start an interactive chat session with the user and help them directly.",
    "Stay in this conversation until the user is done.",
    'When you are completely finished and want to hand control back to Smithers, return ONLY this raw JSON object with no prose, markdown, or code fence: {}.',
].join("\n\n");
/**
 * @param {"claude-code" | "codex" | "antigravity"} agentId
 * @param {string} cwd
 */
async function createChatAgent(agentId, cwd) {
    switch (agentId) {
        case "claude-code": {
            const { ClaudeCodeAgent } = await import("@smithers-orchestrator/agents/ClaudeCodeAgent");
            return new ClaudeCodeAgent({
                cwd,
                model: "claude-fable-5",
            });
        }
        case "codex": {
            const { CodexAgent } = await import("@smithers-orchestrator/agents/CodexAgent");
            return new CodexAgent({
                cwd,
                model: "gpt-5.5",
                skipGitRepoCheck: true,
            });
        }
        case "antigravity": {
            const { AntigravityAgent } = await import("@smithers-orchestrator/agents/AntigravityAgent");
            return new AntigravityAgent({
                cwd,
            });
        }
    }
}
/**
 * @param {"claude-code" | "codex" | "antigravity"} agentId
 * @param {string} cwd
 * @returns {Promise<import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>>}
 */
async function buildInlineChatWorkflow(agentId, cwd) {
    const [
        { Database },
        { drizzle },
        { sqliteTable, text },
        { Workflow, Task },
        { zodToTable },
        { syncZodTableSchema },
        { camelToSnake },
        { z: zod },
    ] = await Promise.all([
        import("bun:sqlite"),
        import("drizzle-orm/bun-sqlite"),
        import("drizzle-orm/sqlite-core"),
        import("@smithers-orchestrator/components"),
        import("@smithers-orchestrator/db/zodToTable"),
        import("@smithers-orchestrator/db/zodToCreateTableSQL"),
        import("@smithers-orchestrator/db/utils/camelToSnake"),
        import("zod"),
    ]);
    const agent = await createChatAgent(agentId, cwd);
    const chatSchema = zod.object({});
    const inputTable = sqliteTable("input", {
        runId: text("run_id").primaryKey(),
        payload: text("payload", { mode: "json" }).$type(),
    });
    const chatTableName = camelToSnake("chat");
    const chatTable = zodToTable(chatTableName, chatSchema);
    const sqlite = new Database(resolve(cwd, "smithers.db"));
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run("PRAGMA busy_timeout = 30000");
    sqlite.run("PRAGMA synchronous = NORMAL");
    sqlite.run("PRAGMA locking_mode = NORMAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    sqlite.exec(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
    syncZodTableSchema(sqlite, chatTableName, chatSchema);
    const db = drizzle(sqlite, { schema: { input: inputTable, chat: chatTable } });
    const schemaRegistry = new Map([["chat", { table: chatTable, zodSchema: chatSchema }]]);
    const zodToKeyName = new Map([[chatSchema, "chat"]]);
    return {
        db,
        build: () => React.createElement(Workflow, { name: "chat" }, React.createElement(Task, {
            id: "chat",
            output: chatSchema,
            agent,
            hijack: true,
        }, CHAT_CREATE_PROMPT)),
        opts: {},
        schemaRegistry,
        zodToKeyName,
    };
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
async function main() {
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
        console.error(`Unknown command: ${command}`);
        process.exit(4);
    }
    // Self-heal the curated agent skill on a normal human-facing invocation:
    // keep ~/.claude/skills (and Pi) in sync with the bundled skill and evict
    // any retired `smithers-orchestrator` copy. Throttled + best-effort; skipped
    // in JSON mode (machine output / e2e) and for completions/version/help so it
    // never adds noise or latency to scripted use. Opt out with
    // SMITHERS_NO_SKILL_REFRESH=1.
    if (command &&
        command !== "completions" &&
        !argvRequestsJsonMode(argv) &&
        !argv.includes("--version") &&
        !argv.includes("--help") &&
        !argv.includes("-h")) {
        const refreshNotice = formatRefreshNotice(ensureCuratedSkillsFresh());
        if (refreshNotice) console.error(refreshNotice);
    }
    // `--backend` is a registered option only on up/gateway/monitor/workflow.
    // The SMITHERS_MIGRATION_REQUIRED error tells users to run any command with
    // `--backend sqlite`, so lift it into SMITHERS_BACKEND for every other command
    // instead of letting incur reject it as an unknown flag.
    const NATIVE_BACKEND_COMMANDS = new Set(["up", "gateway", "monitor", "workflow"]);
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
main();

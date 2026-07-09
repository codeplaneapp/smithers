#!/usr/bin/env bun
/**
 * Semantic watchdog for codex-issue-merge-queue runs.
 *
 * Cron command (one-shot is the default; schedule it every five minutes).
 * Cron usually has a minimal PATH, so use absolute paths or set PATH and
 * SMITHERS_BIN explicitly:
 *   PATH=/usr/local/bin:/usr/bin:/bin SMITHERS_BIN=/path/to/smithers \
 *     /path/to/bun /path/to/repo/.smithers/scripts/codex-issue-merge-watchdog.ts --root /path/to/repo --run-id RUN_ID
 *
 * Smithers' supervisor should run alongside this script for process-level stale
 * owner recovery. This watchdog asks Terra to diagnose semantic progress and
 * only invokes Sol when repair is actually required.
 */
// crontab: */5 * * * * PATH=/usr/local/bin:/usr/bin:/bin SMITHERS_BIN=/absolute/path/to/smithers /absolute/path/to/bun /path/to/repo/.smithers/scripts/codex-issue-merge-watchdog.ts --root /path/to/repo RUN_ID
import { ClaudeCodeAgent, type AgentLike } from "smithers-orchestrator";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { codexFirst } from "../lib/codexAccounts";

export type WatchdogOptions = {
  runId: string;
  once: boolean;
  intervalSeconds: number;
  cooldownMinutes: number;
  rootDir: string;
  stateDir: string;
};

export type HealthDecision = {
  healthy: boolean;
  repairRequired: boolean;
  state: string;
  reason: string;
  recommendedAction: string;
};

type PersistedState = {
  activeRunId?: string;
  lastCheckedAt?: number;
  lastEscalatedAt?: number;
  lastDecision?: HealthDecision;
  lastSolResult?: string;
  lastSolStatus?: "started" | "succeeded" | "failed";
  progress?: PersistedProgress;
  lastReplacement?: {
    fromRunId: string;
    toRunId: string;
    followedAt: number;
  };
};

export type WatchdogLease = {
  path: string;
  pid: number;
  createdAt: number;
  token: string;
};

type SmithersCommandOptions = {
  binary?: string;
  timeoutMs?: number;
  eventsSinceTimestampMs?: number;
};

export type WorkflowRunSummary = {
  successful?: boolean;
  blocked?: number;
  selected?: number;
  mergedLocally?: number;
};

export type EventEvidence = {
  runId: string;
  seq: number;
  timestampMs: number;
  type: string;
  payload: Record<string, unknown>;
};

export type ProgressEvidence = {
  runId: string;
  state: string;
  dbStatus: string;
  failedChildren: number;
  latestEvent: {
    seq: number;
    timestampMs: number;
    type: string;
    nodeId: string;
  } | null;
  nodes: Array<{
    id: string;
    state: string;
    attempt: number;
  }>;
};

export type ProgressSnapshot = {
  fingerprint: string;
  evidence: ProgressEvidence;
};

export type PersistedProgress = ProgressSnapshot & {
  runId: string;
  observedAt: number;
  changedAt: number;
  unchangedTicks: number;
};

export type ProgressComparison = {
  current: PersistedProgress;
  changedSinceLastTick: boolean | null;
};

export type SolRepairResult = {
  outcome: "repaired" | "no-change" | "human-required";
  replacementRunId: string | null;
  summary: string;
};

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_COOLDOWN_MINUTES = 30;
const MAX_CONTEXT_BYTES = 24_000;
const DEFAULT_SMITHERS_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_LOCK_STALE_TTL_MS = 2 * 60 * 60_000;
const MAX_RUN_KEY_PREFIX = 48;
const MAX_EVENT_HISTORY = 100_000;
const EVENT_CURSOR_OVERLAP_MS = 60_000;
const SIDE_EFFECT_NODE_NAMES = new Set(["sync-pr", "queue-rebase", "land-prepare", "land-local-main"]);
const AMBIGUOUS_NODE_STATES = new Set(["in-progress", "failed", "cancelled", "canceled", "error", "stale"]);
const NODE_LIFECYCLE_EVENTS = new Set(["NodeStarted", "NodeFinished", "NodeFailed", "NodeCancelled", "NodeSkipped"]);

export function parseWatchdogArgs(argv: string[], cwd = process.cwd()): WatchdogOptions {
  let runId = "";
  let once = false;
  let intervalSeconds: number | undefined;
  let cooldownMinutes = DEFAULT_COOLDOWN_MINUTES;
  let rootDir = cwd;
  let stateDir = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--run-id" || arg === "-r") runId = next();
    else if (arg === "--once") once = true;
    else if (arg === "--interval-seconds") intervalSeconds = positiveNumber(next(), arg);
    else if (arg === "--cooldown-minutes") cooldownMinutes = positiveNumber(next(), arg);
    else if (arg === "--root") rootDir = resolve(next());
    else if (arg === "--state-dir") stateDir = resolve(next());
    else if (arg === "--help" || arg === "-h") throw new Error("WATCHDOG_HELP");
    else if (!arg.startsWith("-") && !runId) runId = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!runId.trim()) throw new Error("A run id is required (positional or --run-id RUN_ID).");
  if (!isSafeRunId(runId.trim())) throw new Error("Run id must be 1-200 safe ASCII identifier characters.");
  const resolvedRoot = resolve(rootDir);
  return {
    runId: runId.trim(),
    once: once || intervalSeconds === undefined,
    intervalSeconds: intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
    cooldownMinutes,
    rootDir: resolvedRoot,
    stateDir: stateDir || join(resolvedRoot, ".smithers", "state", "codex-issue-merge-watchdog"),
  };
}

function positiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

export function isSafeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(runId);
}

export function shouldEscalate(now: number, lastEscalatedAt: number | undefined, cooldownMinutes: number): boolean {
  if (!lastEscalatedAt) return true;
  return now - lastEscalatedAt >= cooldownMinutes * 60_000;
}

function inspectState(inspect: unknown): string {
  const envelope = inspect as any;
  const value = envelope?.data ?? envelope;
  return String(value?.runState?.state ?? value?.run?.status ?? value?.status ?? "unknown").toLowerCase();
}

export function parseWorkflowRunSummary(text: string): WorkflowRunSummary | null {
  try {
    const envelope = JSON.parse(text) as any;
    const value = envelope?.data?.row ?? envelope?.data ?? envelope?.row ?? envelope;
    if (!value || typeof value !== "object") return null;
    if (typeof value.successful !== "boolean" || !Number.isFinite(Number(value.blocked))) return null;
    const mergedLocally = value.mergedLocally ?? value.merged_locally;
    return {
      successful: value.successful,
      blocked: Number(value.blocked),
      selected: Number.isFinite(Number(value.selected)) ? Number(value.selected) : undefined,
      mergedLocally: Number.isFinite(Number(mergedLocally)) ? Number(mergedLocally) : undefined,
    };
  } catch {
    return null;
  }
}

export function knownStateDecision(
  inspect: unknown,
  now = Date.now(),
  workflowSummary?: WorkflowRunSummary | null,
): HealthDecision | null {
  const envelope = inspect as any;
  const value = envelope?.data ?? envelope;
  const state = inspectState(inspect);
  const unhealthy = value?.runState?.unhealthy ?? value?.unhealthy;
  if (unhealthy && (["paused"].includes(state) || state.startsWith("waiting-"))) {
    const kind = String(unhealthy?.kind ?? "reported-unhealthy");
    return {
      healthy: false,
      repairRequired: true,
      state,
      reason: `Run metadata marks the durable wait unhealthy (${kind}).`,
      recommendedAction: kind === "timer-overdue"
        ? "resume or supervise the overdue timer"
        : "diagnose and repair the unhealthy durable wait",
    };
  }
  if (["finished", "succeeded", "complete", "completed"].includes(state)) {
    if (Number(value?.failedChildren ?? 0) > 0) return null;
    if (workflowSummary?.successful === false || Number(workflowSummary?.blocked ?? 0) > 0) {
      return {
        healthy: false,
        repairRequired: true,
        state,
        reason: `Run ended cleanly at the engine level but its workflow summary reports ${workflowSummary?.blocked ?? "unknown"} blocked issue(s).`,
        recommendedAction: "inspect unresolved issue lanes and repair or start a fresh run",
      };
    }
    if (workflowSummary?.successful === true) {
      return { healthy: true, repairRequired: false, state, reason: "Run and workflow summary completed successfully.", recommendedAction: "none" };
    }
    // This workflow can finish with tolerated child failures and ordinary
    // blocked outputs. Never call a terminal run healthy without its summary.
    return null;
  }
  if (state === "waiting-quota") {
    const resetAtMs = Number(value?.runState?.blocked?.resetAtMs ?? value?.run?.error?.resetAtMs ?? value?.resetAtMs);
    if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return null;
    if (resetAtMs <= now) {
      return { healthy: false, repairRequired: true, state, reason: "The declared quota reset passed but the run is still parked.", recommendedAction: "resume or supervise the run" };
    }
    return { healthy: true, repairRequired: false, state, reason: "Run is durably parked until its quota reset.", recommendedAction: "wait for the declared quota reset" };
  }
  if (["waiting-approval", "waiting-event", "waiting-human", "waiting-timer", "waiting-signal", "paused"].includes(state)) {
    return { healthy: true, repairRequired: false, state, reason: `Run is durably parked in ${state}.`, recommendedAction: "wait for the declared durable condition" };
  }
  if (["cancelled", "canceled"].includes(state)) {
    return { healthy: false, repairRequired: false, state, reason: "Run was intentionally cancelled; watchdog will not restart it.", recommendedAction: "human decision required" };
  }
  if (["failed", "stale", "orphaned", "error"].includes(state)) {
    return { healthy: false, repairRequired: true, state, reason: `Run state is ${state}.`, recommendedAction: "diagnose and repair with Smithers run control" };
  }
  return null;
}

export function parseHealthDecision(text: string): HealthDecision | null {
  try {
    const parsed = JSON.parse(text.trim()) as Partial<HealthDecision>;
    if (typeof parsed.healthy !== "boolean" || typeof parsed.repairRequired !== "boolean") return null;
    if (parsed.healthy && parsed.repairRequired) return null;
    return {
      healthy: parsed.healthy,
      repairRequired: parsed.repairRequired,
      state: String(parsed.state ?? "unknown"),
      reason: String(parsed.reason ?? "No reason supplied."),
      recommendedAction: String(parsed.recommendedAction ?? "inspect manually"),
    };
  } catch {
    return null;
  }
}

function parsedJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function inspectValue(inspect: unknown): any {
  const envelope = inspect as any;
  return envelope?.data ?? envelope;
}

export function parseEventEvidence(text: string): EventEvidence[] | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const events: EventEvidence[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Partial<EventEvidence>;
      if (
        typeof value.runId !== "string"
        || !isSafeRunId(value.runId)
        || typeof value.seq !== "number"
        || !Number.isInteger(value.seq)
        || value.seq < 0
        || typeof value.timestampMs !== "number"
        || !Number.isFinite(value.timestampMs)
        || typeof value.type !== "string"
        || value.type.length === 0
        || value.payload === null
        || typeof value.payload !== "object"
        || Array.isArray(value.payload)
      ) return null;
      events.push({
        runId: value.runId,
        seq: value.seq,
        timestampMs: value.timestampMs,
        type: value.type,
        payload: value.payload as Record<string, unknown>,
      });
    } catch {
      return null;
    }
  }
  events.sort((left, right) => left.seq - right.seq);
  return events;
}

export function progressSnapshot(
  runId: string,
  inspect: unknown,
  events: readonly EventEvidence[],
): ProgressSnapshot | null {
  const value = inspectValue(inspect);
  const state = inspectState(inspect);
  if (!value || typeof value !== "object" || state === "unknown") return null;
  if (value?.run?.id !== runId) return null;
  if (events.some((event) => event.runId !== runId)) return null;
  const steps = value.steps;
  if (!Array.isArray(steps)) return null;
  const nodes: ProgressEvidence["nodes"] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object" || typeof step.id !== "string" || typeof step.state !== "string") {
      return null;
    }
    const attempt = Number(step.attempt ?? 0);
    if (!Number.isInteger(attempt) || attempt < 0) return null;
    nodes.push({ id: step.id, state: step.state.toLowerCase(), attempt });
  }
  nodes.sort((left, right) => left.id.localeCompare(right.id) || left.attempt - right.attempt);
  const latest = events.at(-1) ?? null;
  const latestNodeId = latest && typeof latest.payload.nodeId === "string" ? latest.payload.nodeId : "";
  const evidence: ProgressEvidence = {
    runId,
    state,
    dbStatus: String(value?.run?.status ?? value?.status ?? state).toLowerCase(),
    failedChildren: Number.isFinite(Number(value.failedChildren)) ? Number(value.failedChildren) : 0,
    latestEvent: latest
      ? {
          seq: latest.seq,
          timestampMs: latest.timestampMs,
          type: latest.type,
          nodeId: latestNodeId,
        }
      : null,
    nodes,
  };
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex"),
    evidence,
  };
}

export function compareProgress(
  previous: PersistedProgress | undefined,
  snapshot: ProgressSnapshot,
  now: number,
): ProgressComparison {
  const comparable = previous?.runId === snapshot.evidence.runId;
  const changed = !comparable || previous?.fingerprint !== snapshot.fingerprint;
  return {
    changedSinceLastTick: previous && comparable ? changed : null,
    current: {
      ...snapshot,
      runId: snapshot.evidence.runId,
      observedAt: now,
      changedAt: changed ? now : previous.changedAt,
      unchangedTicks: changed ? 0 : previous.unchangedTicks + 1,
    },
  };
}

function isSideEffectNode(nodeId: string): boolean {
  const leaf = nodeId.split(":").at(-1) ?? nodeId;
  return SIDE_EFFECT_NODE_NAMES.has(leaf);
}

export function ambiguousSideEffectNodes(
  inspect: unknown,
  events: readonly EventEvidence[],
): string[] {
  const value = inspectValue(inspect);
  const ambiguous = new Set<string>();
  for (const step of Array.isArray(value?.steps) ? value.steps : []) {
    if (!step || typeof step.id !== "string" || !isSideEffectNode(step.id)) continue;
    const state = String(step.state ?? "unknown").toLowerCase();
    if (AMBIGUOUS_NODE_STATES.has(state) || state.startsWith("waiting-")) ambiguous.add(step.id);
  }

  const latestLifecycle = new Map<string, string>();
  for (const event of events) {
    const nodeId = typeof event.payload.nodeId === "string" ? event.payload.nodeId : "";
    if (nodeId && isSideEffectNode(nodeId) && NODE_LIFECYCLE_EVENTS.has(event.type)) {
      latestLifecycle.set(nodeId, event.type);
    }
  }
  for (const [nodeId, type] of latestLifecycle) {
    // A settled event never cancels contradictory risky inspect state; that
    // disagreement is itself ambiguous. Conversely, a risky latest event must
    // block repair even if the materialized node row still says pending or
    // finished.
    if (type === "NodeStarted" || type === "NodeFailed" || type === "NodeCancelled") {
      ambiguous.add(nodeId);
    }
  }
  return [...ambiguous].sort();
}

export function parseSolRepairResult(text: string, currentRunId: string): SolRepairResult | null {
  try {
    const value = JSON.parse(text.trim()) as Partial<SolRepairResult>;
    if (!value || typeof value !== "object") return null;
    if (!(["repaired", "no-change", "human-required"] as const).includes(value.outcome as any)) return null;
    if (typeof value.summary !== "string" || value.summary.trim().length === 0) return null;
    if (value.replacementRunId !== null && typeof value.replacementRunId !== "string") return null;
    if (typeof value.replacementRunId === "string") {
      if (!isSafeRunId(value.replacementRunId) || value.replacementRunId === currentRunId || value.outcome !== "repaired") return null;
    }
    return {
      outcome: value.outcome as SolRepairResult["outcome"],
      replacementRunId: value.replacementRunId ?? null,
      summary: value.summary.trim(),
    };
  } catch {
    return null;
  }
}

export function decisionAfterSolRepair(
  decision: HealthDecision,
  repair: SolRepairResult,
): { decision: HealthDecision; manualInterventionRequired: boolean } {
  if (repair.outcome !== "human-required") {
    return { decision, manualInterventionRequired: false };
  }
  return {
    decision: {
      healthy: false,
      repairRequired: false,
      state: "repair-human-required",
      reason: repair.summary,
      recommendedAction: "perform the requested human reconciliation before resuming",
    },
    manualInterventionRequired: true,
  };
}

function inspectRun(inspect: unknown): any {
  return inspectValue(inspect)?.run;
}

export function validateReplacementRun(
  currentInspect: unknown,
  replacementInspect: unknown,
  currentRunId: string,
  replacementRunId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isSafeRunId(replacementRunId) || replacementRunId === currentRunId) {
    return { ok: false, reason: "Replacement run id is unsafe or unchanged." };
  }
  const current = inspectRun(currentInspect);
  const replacement = inspectRun(replacementInspect);
  if (!replacement || replacement.id !== replacementRunId || inspectState(replacementInspect) === "unknown") {
    return { ok: false, reason: "Replacement inspect did not identify the reported run." };
  }
  const currentWorkflow = typeof current?.workflow === "string" ? current.workflow : "";
  const replacementWorkflow = typeof replacement.workflow === "string" ? replacement.workflow : "";
  if (!currentWorkflow || replacementWorkflow !== currentWorkflow) {
    return { ok: false, reason: "Replacement run belongs to a different or unknown workflow." };
  }
  const lineage = Array.isArray(replacement.continuedFrom) ? replacement.continuedFrom : [];
  const linked = replacement.parentRunId === currentRunId || lineage.includes(currentRunId);
  if (!linked) {
    return { ok: false, reason: "Replacement run is not durably linked to the current run by parentRunId or continuedFrom." };
  }
  return { ok: true };
}

export function boundedContext(value: string, maxBytes = MAX_CONTEXT_BYTES): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return `[truncated to final ${maxBytes} bytes]\n${bytes.subarray(start).toString("utf8")}`;
}

export function stateKeyForRunId(runId: string): string {
  const digest = createHash("sha256").update(runId, "utf8").digest("hex");
  const prefix = runId
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[.-]+/, "")
    .slice(0, MAX_RUN_KEY_PREFIX) || "run";
  return `${prefix}-${digest}`;
}

function readState(path: string): PersistedState {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Watchdog state JSON is malformed: ${errorText(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Watchdog state JSON must be an object.");
  const state = parsed as PersistedState;
  if (state.activeRunId !== undefined && !isSafeRunId(state.activeRunId)) throw new Error("Watchdog state has an unsafe active run id.");
  for (const [name, value] of [
    ["lastCheckedAt", state.lastCheckedAt],
    ["lastEscalatedAt", state.lastEscalatedAt],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`Watchdog state has an invalid ${name}.`);
  }
  if (state.lastSolStatus !== undefined && !["started", "succeeded", "failed"].includes(state.lastSolStatus)) {
    throw new Error("Watchdog state has an invalid Sol status.");
  }
  if (state.progress) {
    const progress = state.progress;
    if (
      !isSafeRunId(progress.runId)
      || !/^[a-f0-9]{64}$/.test(progress.fingerprint)
      || !Number.isFinite(progress.observedAt)
      || !Number.isFinite(progress.changedAt)
      || !Number.isInteger(progress.unchangedTicks)
      || progress.unchangedTicks < 0
      || !progress.evidence
      || progress.evidence.runId !== progress.runId
      || !Array.isArray(progress.evidence.nodes)
    ) throw new Error("Watchdog state has invalid progress evidence.");
  }
  return state;
}

function writeState(path: string, state: PersistedState): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readLease(path: string): WatchdogLease | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, "lease.json"), "utf8")) as Partial<WatchdogLease>;
    if (
      typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.createdAt !== "number"
      || !Number.isFinite(parsed.createdAt)
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
    ) return null;
    return { path, pid: parsed.pid, createdAt: parsed.createdAt, token: parsed.token };
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function lockCreatedAt(path: string): number | null {
  try {
    const modifiedAt = statSync(path).mtimeMs;
    return Number.isFinite(modifiedAt) ? modifiedAt : null;
  } catch {
    return null;
  }
}

export function acquireLeaseLock(
  path: string,
  now = Date.now(),
  staleTtlMs = DEFAULT_LOCK_STALE_TTL_MS,
  pid = process.pid,
): WatchdogLease | null {
  if (!Number.isFinite(staleTtlMs) || staleTtlMs <= 0) throw new Error("Lock stale TTL must be positive.");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(path);
      const lease = { path, pid, createdAt: now, token: randomUUID() };
      try {
        writeFileSync(join(path, "lease.json"), `${JSON.stringify(lease)}\n`, { mode: 0o600 });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      return lease;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existing = readLease(path);
    const createdAt = existing?.createdAt ?? lockCreatedAt(path);
    const staleByAge = createdAt !== null && now - createdAt >= staleTtlMs;
    const ownerExited = existing !== null && !pidIsAlive(existing.pid);
    // A valid live PID owns its lease regardless of age: Terra/Sol calls can be
    // long, and wall-clock age alone must never create overlapping repair
    // agents. TTL recovery applies only to an incomplete/corrupt lock whose
    // owner metadata was never durably written; a recorded dead PID is also
    // safe to reclaim immediately.
    const incompleteLockExpired = existing === null && staleByAge;
    if (!ownerExited && !incompleteLockExpired) return null;

    const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, stalePath);
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "EEXIST") continue;
      throw error;
    }
    rmSync(stalePath, { recursive: true, force: true });
  }
  return null;
}

export function releaseLeaseLock(lease: WatchdogLease): void {
  const current = readLease(lease.path);
  if (
    current?.pid === lease.pid
    && current.createdAt === lease.createdAt
    && current.token === lease.token
  ) rmSync(lease.path, { recursive: true, force: true });
}

export function runSmithersJson(
  command: "events" | "inspect" | "why" | "summary",
  runId: string,
  cwd: string,
  options: SmithersCommandOptions = {},
): { ok: boolean; output: string } {
  const binary = options.binary?.trim() || process.env.SMITHERS_BIN?.trim() || "smithers";
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMITHERS_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Smithers command timeout must be positive.");
  if (options.eventsSinceTimestampMs !== undefined && (!Number.isFinite(options.eventsSinceTimestampMs) || options.eventsSinceTimestampMs < 0)) {
    throw new Error("Events cursor timestamp must be a non-negative finite number.");
  }
  const eventSinceDurationMs = options.eventsSinceTimestampMs === undefined
    ? null
    : Math.max(1, Date.now() - options.eventsSinceTimestampMs + EVENT_CURSOR_OVERLAP_MS);
  const args = command === "inspect"
    ? ["inspect", runId, "--format", "json", "--full-output"]
    : command === "events"
      ? [
          "events", runId, "--json", "--type", "node", "--limit", String(MAX_EVENT_HISTORY),
          ...(eventSinceDurationMs === null ? [] : ["--since", String(eventSinceDurationMs)]),
        ]
      : command === "summary"
        ? ["output", runId, "run-summary", "--format", "json", "--full-output"]
        : ["why", runId, "--format", "json"];
  try {
    return {
      ok: true,
      output: execFileSync(binary, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      }),
    };
  } catch (error: any) {
    return {
      ok: false,
      output: [error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "", error?.message ?? String(error)].filter(Boolean).join("\n"),
    };
  }
}

async function askTerra(runId: string, inspect: string, why: string, rootDir: string): Promise<HealthDecision | null> {
  const terra = codexFirst({
    model: "gpt-5.6-terra",
    config: { model_reasoning_effort: "medium" },
    sandbox: "read-only",
    yolo: false,
    skipGitRepoCheck: true,
  }, [
    new ClaudeCodeAgent({
      model: "claude-sonnet-5",
      systemPrompt: "You are the Sonnet fallback for Terra's read-only Smithers health-check role.",
      permissionMode: "plan",
    }),
  ]);
  const text = await generateWithAgentFallback(terra, {
    rootDir,
    timeout: { totalMs: 10 * 60_000, idleMs: 2 * 60_000 },
    prompt: [
      `You are serving the Terra read-only health-check role for Smithers run ${runId}.`,
      "Judge whether the workflow is making healthy durable progress. Waiting for an explicit approval, signal, timer, or known quota reset is healthy. Running with no recent progress, stale/orphaned owners, dependency deadlocks, repeated gate failures, and failed nodes are unhealthy.",
      "The inspect context includes a persisted PROGRESS COMPARISON derived only from durable event sequence and node-state transitions. Use unchangedTicks and changedAt to distinguish a quiet healthy interval from a genuinely stalled running run.",
      "Do not edit files, mutate the run, approve anything, merge, or push.",
      "Return ONLY one JSON object: {\"healthy\":boolean,\"repairRequired\":boolean,\"state\":string,\"reason\":string,\"recommendedAction\":string}.",
      "", "SMITHERS INSPECT:", boundedContext(inspect), "", "SMITHERS WHY:", boundedContext(why),
    ].join("\n"),
  }, (candidate) => parseHealthDecision(candidate) !== null);
  return parseHealthDecision(text);
}

/**
 * Run the same sequential provider chain that Task `agent={[...]}` uses. The
 * watchdog is a standalone Bun process rather than a workflow Task, so it
 * applies the array explicitly while preserving preflight-first failover.
 */
export async function generateWithAgentFallback(
  agents: AgentLike[],
  request: Parameters<AgentLike["generate"]>[0],
  usable: (text: string) => boolean = (text) => text.trim().length > 0,
): Promise<string> {
  if (agents.length === 0) throw new Error("Agent fallback chain must not be empty.");
  for (const agent of agents) {
    try {
      await agent.preflight?.(request);
      const result = await agent.generate(request) as { text?: unknown } | null;
      const text = typeof result?.text === "string" ? result.text : "";
      if (!usable(text)) throw new Error("Agent returned unusable output.");
      return text;
    } catch {
      // Provider/auth/preflight/schema failures fall through to the next agent.
    }
  }
  throw new Error(`All ${agents.length} configured watchdog agents failed.`);
}

async function askSolToRepair(
  runId: string,
  decision: HealthDecision,
  inspect: string,
  why: string,
  rootDir: string,
): Promise<string> {
  const sol = codexFirst({
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "xhigh" },
    sandbox: "workspace-write",
    fullAuto: true,
    yolo: false,
    skipGitRepoCheck: true,
  }, [
    new ClaudeCodeAgent({
      model: "claude-fable-5",
      systemPrompt: "You are the Fable fallback for the Sol Smithers-repair role. Preserve Sol's safety constraints and return the exact requested JSON shape.",
      permissionMode: "bypassPermissions",
    }),
  ]);
  return generateWithAgentFallback(sol, {
    rootDir,
    timeout: { totalMs: 45 * 60_000, idleMs: 10 * 60_000 },
    prompt: [
      `You are serving the Sol repair role for unhealthy Smithers run ${runId} in ${rootDir}.`,
      `Terra diagnosis: ${JSON.stringify(decision)}`,
      "Use Smithers run-control commands first: inspect, why, logs/events, supervise/resume, retry-task, or fork as appropriate. Make the smallest safe repair and verify that durable progress resumes.",
      "Never auto-approve or deny a human gate. Never merge, land, or push branches/main. Never expose credentials.",
      "Never retry, resume through, or fork from a side-effecting sync-pr, queue-rebase, land-prepare, or land-local-main node. If one of those nodes was in flight or may have completed without persisting output, stop and require a human to reconcile VCS state.",
      "Editing a workflow changes its durability hash: if source code truly needs repair, verify the change, then use a Smithers fork/replay that durably records parentRunId or continuedFrom. Do NOT blindly resume an old run against changed source, and do not report an unlinked run as the replacement.",
      "Preserve unrelated working-copy changes. Do not commit.",
      `Return ONLY one JSON object: {"outcome":"repaired"|"no-change"|"human-required","replacementRunId":string|null,"summary":string}. replacementRunId must be null unless you actually created or selected a different active run from ${runId}; when non-null it must be that exact run id.`,
      "", "SMITHERS INSPECT:", boundedContext(inspect), "", "SMITHERS WHY:", boundedContext(why),
    ].join("\n"),
  }, (candidate) => parseSolRepairResult(candidate, runId) !== null);
}

function diagnosticFailureDecision(state: string, reason: string): HealthDecision {
  return {
    healthy: false,
    repairRequired: false,
    state,
    reason,
    recommendedAction: "restore watchdog diagnostics, then retry the health check",
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export async function watchdogTick(options: WatchdogOptions, now = Date.now()): Promise<Record<string, unknown>> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const requestedRunId = options.runId;
  const name = stateKeyForRunId(requestedRunId);
  const lockPath = join(options.stateDir, `${name}.lock`);
  const statePath = join(options.stateDir, `${name}.json`);
  const lease = acquireLeaseLock(lockPath, now);
  if (!lease) return { runId: requestedRunId, skipped: true, reason: "another watchdog tick holds the lock" };

  try {
    const previous = readState(statePath);
    const activeRunId = previous.activeRunId ?? requestedRunId;
    if (!isSafeRunId(activeRunId)) {
      const decision = diagnosticFailureDecision(
        "diagnostic-state-invalid",
        "Persisted active run id is malformed; refusing to invoke Smithers or an automated repair agent.",
      );
      writeState(statePath, { ...previous, lastCheckedAt: now, lastDecision: decision });
      return {
        runId: requestedRunId,
        activeRunId,
        healthy: false,
        repairRequired: false,
        diagnosticFailure: true,
        decision,
        statePath,
      };
    }

    const inspectResult = runSmithersJson("inspect", activeRunId, options.rootDir);
    const whyResult = runSmithersJson("why", activeRunId, options.rootDir);
    const eventsResult = runSmithersJson("events", activeRunId, options.rootDir, {
      eventsSinceTimestampMs: previous.progress?.runId === activeRunId
        ? previous.progress.evidence.latestEvent?.timestampMs
        : undefined,
    });
    const inspectJson = inspectResult.ok ? parsedJson(inspectResult.output) : null;
    const whyJson = whyResult.ok ? parsedJson(whyResult.output) : null;
    const events = eventsResult.ok ? parseEventEvidence(eventsResult.output) : null;
    const inspectStructured = Boolean(
      inspectJson
      && typeof inspectJson === "object"
      && (inspectJson as any)?.ok !== false
      && inspectState(inspectJson) !== "unknown"
      && Array.isArray(inspectValue(inspectJson)?.steps),
    );
    const snapshot = inspectStructured && events ? progressSnapshot(activeRunId, inspectJson, events) : null;
    const comparison = snapshot ? compareProgress(previous.progress, snapshot, now) : null;

    const needsWorkflowSummary = inspectJson
      ? ["finished", "succeeded", "complete", "completed"].includes(inspectState(inspectJson))
      : false;
    const summaryResult = needsWorkflowSummary
      ? runSmithersJson("summary", activeRunId, options.rootDir)
      : null;
    const workflowSummary = summaryResult?.ok ? parseWorkflowRunSummary(summaryResult.output) : null;
    const diagnosticContext = [
      inspectResult.output,
      events ? `\nRECENT DURABLE EVENTS:\n${JSON.stringify(events.slice(-200), null, 2)}` : "",
      summaryResult ? `\nWORKFLOW RUN SUMMARY:\n${summaryResult.output}` : "",
      // Keep this last: boundedContext preserves the tail, so the cross-tick
      // comparison cannot be displaced by a large inspect/event payload.
      comparison ? `\nPROGRESS COMPARISON:\n${JSON.stringify({
        changedSinceLastTick: comparison.changedSinceLastTick,
        changedAt: comparison.current.changedAt,
        observedAt: comparison.current.observedAt,
        unchangedTicks: comparison.current.unchangedTicks,
        evidence: comparison.current.evidence,
      }, null, 2)}` : "",
    ].join("");

    let decision: HealthDecision;
    let diagnosticFailure = false;
    let manualInterventionRequired = false;
    const diagnosticFailures = [
      !inspectResult.ok ? "inspect command" : "",
      inspectResult.ok && !inspectStructured ? "inspect JSON" : "",
      !whyResult.ok ? "why command" : "",
      whyResult.ok && (!whyJson || typeof whyJson !== "object" || (whyJson as any)?.ok === false) ? "why JSON" : "",
      !eventsResult.ok ? "events command" : "",
      eventsResult.ok && events === null ? "events NDJSON" : "",
      inspectStructured && events !== null && !snapshot ? "cross-run progress evidence" : "",
      needsWorkflowSummary && !summaryResult?.ok ? "run-summary command" : "",
      needsWorkflowSummary && summaryResult?.ok && !workflowSummary ? "run-summary JSON" : "",
    ].filter(Boolean);

    if (diagnosticFailures.length > 0) {
      diagnosticFailure = true;
      const failures = [
        ...diagnosticFailures,
      ].join(", ");
      decision = diagnosticFailureDecision(
        "diagnostic-invalid",
        `Smithers diagnostics failed or returned malformed structured data (${failures}); refusing automated repair.`,
      );
    } else {
      const known = knownStateDecision(inspectJson, now, workflowSummary);
      if (known) {
        decision = known;
      } else {
        try {
          const terraDecision = await askTerra(activeRunId, diagnosticContext, whyResult.output, options.rootDir);
          if (terraDecision) {
            decision = terraDecision;
          } else {
            diagnosticFailure = true;
            decision = diagnosticFailureDecision(
              "diagnostic-invalid",
              "Terra did not return a valid, internally consistent health decision.",
            );
          }
        } catch (error) {
          diagnosticFailure = true;
          decision = diagnosticFailureDecision(
            "diagnostic-terra-failed",
            `Terra health check failed (${errorText(error)}).`,
          );
        }
      }
    }

    const ambiguousNodes = inspectJson && events ? ambiguousSideEffectNodes(inspectJson, events) : [];
    if (decision.repairRequired && ambiguousNodes.length > 0) {
      manualInterventionRequired = true;
      decision = {
        healthy: false,
        repairRequired: false,
        state: "side-effect-reconciliation-required",
        reason: `Automated repair is forbidden because side-effecting node state is ambiguous: ${ambiguousNodes.join(", ")}.`,
        recommendedAction: "reconcile the PR, branch, queue, and local-main state manually before resuming",
      };
    }

    const next: PersistedState = {
      ...previous,
      activeRunId,
      lastCheckedAt: now,
      lastDecision: decision,
      ...(comparison ? { progress: comparison.current } : {}),
    };
    let escalated = false;
    let cooldown = false;
    let replacementRunId: string | null = null;

    if (decision.repairRequired) {
      if (shouldEscalate(now, previous.lastEscalatedAt, options.cooldownMinutes)) {
        next.lastEscalatedAt = now;
        next.lastSolStatus = "started";
        next.lastSolResult = `Sol escalation started at ${new Date(now).toISOString()}.`;
        // Reserve the cooldown before the long-running agent call. A crash or
        // timeout must not cause the next cron tick to immediately invoke a
        // second repair agent against the same run.
        writeState(statePath, next);
        escalated = true;
        try {
          const solText = await askSolToRepair(
            activeRunId,
            decision,
            diagnosticContext,
            whyResult.output,
            options.rootDir,
          );
          const repair = parseSolRepairResult(solText, activeRunId);
          if (!repair) throw new Error("Sol returned malformed or unsafe repair JSON.");
          next.lastSolResult = boundedContext(JSON.stringify(repair));
          next.lastSolStatus = "succeeded";
          const repairDecision = decisionAfterSolRepair(decision, repair);
          decision = repairDecision.decision;
          manualInterventionRequired ||= repairDecision.manualInterventionRequired;
          next.lastDecision = decision;
          replacementRunId = repair.replacementRunId;
          if (replacementRunId) {
            const replacementInspectResult = runSmithersJson("inspect", replacementRunId, options.rootDir);
            const replacementInspect = replacementInspectResult.ok
              ? parsedJson(replacementInspectResult.output)
              : null;
            const validation = replacementInspect
              ? validateReplacementRun(inspectJson, replacementInspect, activeRunId, replacementRunId)
              : { ok: false as const, reason: "Replacement inspect command failed or returned malformed JSON." };
            if (!validation.ok) throw new Error(`Unsafe replacement run: ${validation.reason}`);
            next.activeRunId = replacementRunId;
            next.lastReplacement = {
              fromRunId: activeRunId,
              toRunId: replacementRunId,
              followedAt: Date.now(),
            };
            next.progress = undefined;
          }
        } catch (error) {
          next.lastSolStatus = "failed";
          next.lastSolResult = boundedContext(`Sol repair failed: ${errorText(error)}`);
          throw error;
        } finally {
          // This records failures as well as success. The pre-call reservation
          // above remains durable even if the agent process never returns.
          next.lastEscalatedAt = Date.now();
          writeState(statePath, next);
        }
      } else {
        cooldown = true;
      }
    }
    writeState(statePath, next);
    return {
      runId: requestedRunId,
      activeRunId: next.activeRunId,
      replacementRunId,
      healthy: decision.healthy,
      repairRequired: decision.repairRequired,
      decision,
      diagnosticFailure,
      manualInterventionRequired,
      ambiguousSideEffectNodes: ambiguousNodes,
      progress: comparison ? {
        fingerprint: comparison.current.fingerprint,
        changedSinceLastTick: comparison.changedSinceLastTick,
        changedAt: comparison.current.changedAt,
        unchangedTicks: comparison.current.unchangedTicks,
      } : null,
      escalated,
      cooldown,
      inspectOk: inspectResult.ok,
      whyOk: whyResult.ok,
      eventsOk: eventsResult.ok,
      summaryOk: summaryResult?.ok ?? !needsWorkflowSummary,
      statePath,
    };
  } finally {
    releaseLeaseLock(lease);
  }
}

function usage(): string {
  return [
    "Usage: bun .smithers/scripts/codex-issue-merge-watchdog.ts RUN_ID [options]",
    "", "Options:",
    "  --run-id, -r <id>           Run id (alternative to positional)",
    "  --once                      Run one tick and exit (default without interval)",
    "  --interval-seconds <n>      Keep running and check every n seconds",
    "  --cooldown-minutes <n>      Minimum time between Sol escalations (default 30)",
    "  --root <path>               Workspace root (default cwd)",
    "  --state-dir <path>          Lock/cooldown state directory",
    "", "Cron environment:",
    "  Set PATH for bun and dependencies, and SMITHERS_BIN to an absolute smithers executable path.",
  ].join("\n");
}

export async function watchdogMain(): Promise<void> {
  let options: WatchdogOptions;
  try {
    options = parseWatchdogArgs(Bun.argv.slice(2));
  } catch (error) {
    if (error instanceof Error && error.message === "WATCHDOG_HELP") {
      console.log(usage());
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  do {
    try {
      const result = await watchdogTick(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.diagnosticFailure === true || result.manualInterventionRequired === true) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(JSON.stringify({ runId: options.runId, error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    }
    if (!options.once) await Bun.sleep(options.intervalSeconds * 1_000);
  } while (!options.once);
}

if (import.meta.main) await watchdogMain();

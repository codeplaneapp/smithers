// Turns a kanban bench run's raw telemetry into a structured report.
//
// Inputs:
//   - the engine event log  (.smithers/executions/<runId>/logs/stream.ndjson)
//   - the bench agent log   (bench-agent-log.ndjson, written by agents.bench.ts)
//   - the runner's spawn/exit wall-clock stamps
//
// The report separates agent-visible time (simulated LLM latency) from
// orchestrator time: boot, pre-agent overhead (worktree ensure, DB writes,
// prompt build), post-agent overhead (parse, persist, events), queue waits,
// and global idle gaps where the run is active but no agent is busy.
import { readFileSync } from "node:fs";

export type EngineEvent = {
  type: string;
  runId?: string;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  frameNo?: number;
  timestampMs: number;
};

export type AgentCall = {
  nodeId: string;
  iteration: number;
  attempt: number;
  agentId: string;
  kind: string;
  tStart: number;
  tEnd: number;
  delayMs: number;
};

export type BenchConfig = {
  tickets: number;
  workflowConcurrency: number;
  globalConcurrency: number;
  reviewers: number;
  delays: Record<string, number>;
};

export type NodeSpan = {
  nodeId: string;
  iteration: number;
  attempt: number;
  kind: string;
  pendingMs: number | null;
  startedMs: number | null;
  finishedMs: number | null;
  agent: AgentCall | null;
};

export type IdleGap = { fromMs: number; toMs: number; durationMs: number; afterNode: string; beforeNode: string };

export type KanbanBenchReport = {
  config: BenchConfig;
  wall: {
    processMs: number;
    engineMs: number;
    bootMs: number;
    shutdownMs: number;
  };
  agents: {
    calls: number;
    totalBusyMs: number;
    totalSimulatedDelayMs: number;
    busyUnionMs: number;
    idleWhileRunningMs: number;
    utilizationOfGlobalCap: number;
    maxInFlight: number;
    avgInFlight: number;
  };
  overheadPerKind: Record<
    string,
    { count: number; preAgentMs: Stat; postAgentMs: Stat; queueWaitMs: Stat; agentInternalMs: Stat }
  >;
  frames: { count: number; perNodeFinish: number };
  tickets: Array<{
    slug: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    implementToValidateGapMs: number | null;
    validateToReviewGapMs: number | null;
    loopExitToResultGapMs: number | null;
  }>;
  waves: Array<{ startMs: number; slugs: string[] }>;
  merge: { queueGapMs: number | null; durationMs: number | null; agentDelayMs: number };
  idleGaps: IdleGap[];
  idealLowerBoundMs: number;
  nodes: NodeSpan[];
};

export type Stat = { min: number; p50: number; mean: number; max: number; total: number };

export function stat(values: number[]): Stat {
  if (values.length === 0) return { min: 0, p50: 0, mean: 0, max: 0, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length / 2)],
    mean: total / sorted.length,
    max: sorted[sorted.length - 1],
    total,
  };
}

export function parseNdjson<T>(path: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {}
  }
  return out;
}

function kindOf(nodeId: string): string {
  if (nodeId.endsWith(":implement")) return "implement";
  if (nodeId.endsWith(":validate")) return "validate";
  if (nodeId.includes(":review")) return "review";
  if (nodeId === "merge") return "merge";
  if (nodeId.startsWith("result-")) return "result";
  return "other";
}

function slugOf(nodeId: string): string | null {
  for (const suffix of [":implement", ":validate"]) {
    if (nodeId.endsWith(suffix)) return nodeId.slice(0, -suffix.length);
  }
  const reviewIdx = nodeId.indexOf(":review");
  if (reviewIdx > 0) return nodeId.slice(0, reviewIdx);
  if (nodeId.startsWith("result-")) return nodeId.slice("result-".length);
  return null;
}

function unionMs(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (const [s, e] of sorted.slice(1)) {
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

export function analyzeKanbanBench(input: {
  events: EngineEvent[];
  agentCalls: AgentCall[];
  config: BenchConfig;
  spawnMs: number;
  exitMs: number;
}): KanbanBenchReport {
  const { events, agentCalls, config, spawnMs, exitMs } = input;

  const runStarted = events.find((e) => e.type === "RunStarted")?.timestampMs ?? spawnMs;
  const runFinished = events.find((e) => e.type === "RunFinished")?.timestampMs ?? exitMs;

  const nodeKey = (nodeId: string, iteration: number, attempt: number) => `${nodeId}#${iteration}#${attempt}`;
  const agentByKey = new Map<string, AgentCall>();
  for (const call of agentCalls) agentByKey.set(nodeKey(call.nodeId, call.iteration, call.attempt), call);

  const pendingByNode = new Map<string, number>();
  const nodes: NodeSpan[] = [];
  const nodeIndex = new Map<string, NodeSpan>();
  for (const event of events) {
    if (!event.nodeId) continue;
    const iteration = event.iteration ?? 0;
    if (event.type === "NodePending") {
      pendingByNode.set(`${event.nodeId}#${iteration}`, event.timestampMs);
      continue;
    }
    if (event.type === "NodeStarted") {
      const attempt = event.attempt ?? 1;
      const span: NodeSpan = {
        nodeId: event.nodeId,
        iteration,
        attempt,
        kind: kindOf(event.nodeId),
        pendingMs: pendingByNode.get(`${event.nodeId}#${iteration}`) ?? null,
        startedMs: event.timestampMs,
        finishedMs: null,
        agent: agentByKey.get(nodeKey(event.nodeId, iteration, attempt)) ?? null,
      };
      nodes.push(span);
      nodeIndex.set(nodeKey(event.nodeId, iteration, attempt), span);
      continue;
    }
    if (event.type === "NodeFinished" || event.type === "NodeFailed") {
      const attempt = event.attempt ?? 1;
      const span = nodeIndex.get(nodeKey(event.nodeId, iteration, attempt));
      if (span) span.finishedMs = event.timestampMs;
    }
  }

  // Per-kind overhead decomposition.
  const overheadPerKind: KanbanBenchReport["overheadPerKind"] = {};
  const byKind = new Map<string, { pre: number[]; post: number[]; queue: number[]; internal: number[] }>();
  for (const span of nodes) {
    if (!span.agent || span.startedMs === null || span.finishedMs === null) continue;
    const bucket = byKind.get(span.kind) ?? { pre: [], post: [], queue: [], internal: [] };
    bucket.pre.push(span.agent.tStart - span.startedMs);
    bucket.post.push(span.finishedMs - span.agent.tEnd);
    if (span.pendingMs !== null) bucket.queue.push(span.startedMs - span.pendingMs);
    bucket.internal.push(span.agent.tEnd - span.agent.tStart - span.agent.delayMs);
    byKind.set(span.kind, bucket);
  }
  for (const [kind, bucket] of byKind) {
    overheadPerKind[kind] = {
      count: bucket.pre.length,
      preAgentMs: stat(bucket.pre),
      postAgentMs: stat(bucket.post),
      queueWaitMs: stat(bucket.queue),
      agentInternalMs: stat(bucket.internal),
    };
  }

  // Concurrency profile over agent-busy intervals.
  const intervals: Array<[number, number]> = agentCalls.map((c) => [c.tStart, c.tEnd]);
  const busyUnion = unionMs(intervals);
  const engineMs = Math.max(1, runFinished - runStarted);
  const stepMs = 100;
  let busySamples = 0;
  let sampleCount = 0;
  let maxInFlight = 0;
  for (let t = runStarted; t <= runFinished; t += stepMs) {
    const inFlight = intervals.reduce((n, [s, e]) => n + (s <= t && t < e ? 1 : 0), 0);
    busySamples += inFlight;
    maxInFlight = Math.max(maxInFlight, inFlight);
    sampleCount += 1;
  }

  // Idle gaps: periods with zero busy agents while the run is active.
  const idleGaps: IdleGap[] = [];
  const boundaries = agentCalls
    .flatMap((c) => [
      { t: c.tStart, kind: "start" as const, node: c.nodeId },
      { t: c.tEnd, kind: "end" as const, node: c.nodeId },
    ])
    .sort((a, b) => a.t - b.t);
  let depth = 0;
  let idleFrom = runStarted;
  let lastEnded = "(run start)";
  for (const b of boundaries) {
    if (b.kind === "start") {
      if (depth === 0 && b.t - idleFrom > 0) {
        idleGaps.push({ fromMs: idleFrom, toMs: b.t, durationMs: b.t - idleFrom, afterNode: lastEnded, beforeNode: b.node });
      }
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        idleFrom = b.t;
        lastEnded = b.node;
      }
    }
  }
  if (depth === 0 && runFinished - idleFrom > 0) {
    idleGaps.push({ fromMs: idleFrom, toMs: runFinished, durationMs: runFinished - idleFrom, afterNode: lastEnded, beforeNode: "(run finish)" });
  }
  idleGaps.sort((a, b) => b.durationMs - a.durationMs);

  // Per-ticket spans and sequence gaps (iteration 0 only for gap metrics).
  const slugs = new Set<string>();
  for (const span of nodes) {
    const slug = slugOf(span.nodeId);
    if (slug) slugs.add(slug);
  }
  const tickets: KanbanBenchReport["tickets"] = [];
  for (const slug of [...slugs].sort()) {
    const of = (predicate: (s: NodeSpan) => boolean) => nodes.filter((s) => slugOf(s.nodeId) === slug && predicate(s));
    const implement = of((s) => s.kind === "implement");
    const validate = of((s) => s.kind === "validate");
    const reviews = of((s) => s.kind === "review");
    const result = of((s) => s.kind === "result");
    const all = of(() => true);
    const startMs = Math.min(...all.map((s) => s.startedMs ?? Infinity));
    const endMs = Math.max(...all.map((s) => s.finishedMs ?? 0));
    const i0 = implement.find((s) => s.iteration === 0);
    const v0 = validate.find((s) => s.iteration === 0);
    const r0 = reviews.filter((s) => s.iteration === 0);
    const lastReviewEnd = r0.length ? Math.max(...r0.map((s) => s.finishedMs ?? 0)) : null;
    const resultSpan = result[0];
    tickets.push({
      slug,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      implementToValidateGapMs: i0?.finishedMs != null && v0?.startedMs != null ? v0.startedMs - i0.finishedMs : null,
      validateToReviewGapMs:
        v0?.finishedMs != null && r0.length ? Math.min(...r0.map((s) => s.startedMs ?? Infinity)) - v0.finishedMs : null,
      loopExitToResultGapMs:
        lastReviewEnd != null && resultSpan?.startedMs != null ? resultSpan.startedMs - lastReviewEnd : null,
    });
  }

  // Waves: cluster ticket start times (gap > 2s starts a new wave).
  const byStart = [...tickets].sort((a, b) => a.startMs - b.startMs);
  const waves: KanbanBenchReport["waves"] = [];
  for (const ticket of byStart) {
    const last = waves[waves.length - 1];
    if (!last || ticket.startMs - last.startMs > 2000) {
      waves.push({ startMs: ticket.startMs, slugs: [ticket.slug] });
    } else {
      last.slugs.push(ticket.slug);
    }
  }

  const mergeSpan = nodes.find((s) => s.kind === "merge");
  const lastTicketEnd = tickets.length ? Math.max(...tickets.map((t) => t.endMs)) : null;

  const d = (k: string) => config.delays[k] ?? 0;
  const wavesCount = Math.ceil(config.tickets / config.workflowConcurrency);
  const idealLowerBoundMs = wavesCount * (d("implement") + d("validate") + d("review")) + d("merge");

  return {
    config,
    wall: {
      processMs: exitMs - spawnMs,
      engineMs,
      bootMs: runStarted - spawnMs,
      shutdownMs: exitMs - runFinished,
    },
    agents: {
      calls: agentCalls.length,
      totalBusyMs: agentCalls.reduce((a, c) => a + (c.tEnd - c.tStart), 0),
      totalSimulatedDelayMs: agentCalls.reduce((a, c) => a + c.delayMs, 0),
      busyUnionMs: busyUnion,
      idleWhileRunningMs: engineMs - busyUnion,
      utilizationOfGlobalCap: busySamples / Math.max(1, sampleCount * config.globalConcurrency),
      maxInFlight,
      avgInFlight: busySamples / Math.max(1, sampleCount),
    },
    overheadPerKind,
    frames: {
      count: events.filter((e) => e.type === "FrameCommitted").length,
      perNodeFinish:
        events.filter((e) => e.type === "FrameCommitted").length /
        Math.max(1, events.filter((e) => e.type === "NodeFinished").length),
    },
    tickets,
    waves,
    merge: {
      queueGapMs: mergeSpan?.startedMs != null && lastTicketEnd != null ? mergeSpan.startedMs - lastTicketEnd : null,
      durationMs: mergeSpan?.startedMs != null && mergeSpan.finishedMs != null ? mergeSpan.finishedMs - mergeSpan.startedMs : null,
      agentDelayMs: d("merge"),
    },
    idleGaps: idleGaps.slice(0, 12),
    idealLowerBoundMs,
    nodes,
  };
}

const fmt = (ms: number | null | undefined) => (ms == null ? "n/a" : ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtStat = (s: Stat) => `min ${fmt(s.min)} / p50 ${fmt(s.p50)} / mean ${fmt(s.mean)} / max ${fmt(s.max)}`;

export function renderKanbanBenchReport(report: KanbanBenchReport, label: string): string {
  const lines: string[] = [];
  const runStart = report.nodes.length ? Math.min(...report.nodes.map((n) => n.startedMs ?? Infinity)) : 0;
  lines.push(`## kanban-bench: ${label}`);
  lines.push("");
  lines.push(
    `config: ${report.config.tickets} tickets, workflow concurrency ${report.config.workflowConcurrency}, ` +
      `global maxConcurrency ${report.config.globalConcurrency}, ${report.config.reviewers} reviewers/ticket, ` +
      `delays ${JSON.stringify(report.config.delays)}`,
  );
  lines.push("");
  lines.push(`- process wall:  ${fmt(report.wall.processMs)} (boot ${fmt(report.wall.bootMs)}, engine ${fmt(report.wall.engineMs)}, shutdown ${fmt(report.wall.shutdownMs)})`);
  lines.push(`- ideal lower bound (agent delays only): ${fmt(report.idealLowerBoundMs)}`);
  lines.push(
    `- agents: ${report.agents.calls} calls, busy-union ${fmt(report.agents.busyUnionMs)}, ` +
      `engine idle (no agent busy) ${fmt(report.agents.idleWhileRunningMs)}, ` +
      `in-flight avg ${report.agents.avgInFlight.toFixed(2)} / max ${report.agents.maxInFlight}, ` +
      `global-cap utilization ${(report.agents.utilizationOfGlobalCap * 100).toFixed(0)}%`,
  );
  lines.push(`- frames committed: ${report.frames.count} (${report.frames.perNodeFinish.toFixed(2)} per node finish)`);
  lines.push("");
  lines.push("### per-kind overhead (per agent call)");
  for (const [kind, o] of Object.entries(report.overheadPerKind)) {
    lines.push(`- ${kind} (n=${o.count})`);
    lines.push(`    queue wait     ${fmtStat(o.queueWaitMs)}`);
    lines.push(`    pre-agent      ${fmtStat(o.preAgentMs)}`);
    lines.push(`    post-agent     ${fmtStat(o.postAgentMs)}`);
  }
  lines.push("");
  lines.push("### waves (ticket start clusters)");
  for (const [i, wave] of report.waves.entries()) {
    lines.push(`- wave ${i + 1} @ +${fmt(wave.startMs - runStart)}: ${wave.slugs.join(", ")}`);
  }
  lines.push("");
  lines.push("### per-ticket sequence gaps (iteration 0)");
  const gaps = (key: "implementToValidateGapMs" | "validateToReviewGapMs" | "loopExitToResultGapMs") =>
    stat(report.tickets.map((t) => t[key]).filter((v): v is number => v != null));
  lines.push(`- implement→validate gap: ${fmtStat(gaps("implementToValidateGapMs"))}`);
  lines.push(`- validate→review gap:    ${fmtStat(gaps("validateToReviewGapMs"))}`);
  lines.push(`- review→result gap:      ${fmtStat(gaps("loopExitToResultGapMs"))}`);
  lines.push("");
  lines.push(`### merge queue`);
  lines.push(`- last ticket done → merge started: ${fmt(report.merge.queueGapMs)}`);
  lines.push(`- merge node duration: ${fmt(report.merge.durationMs)} (agent delay ${fmt(report.merge.agentDelayMs)})`);
  lines.push("");
  lines.push("### top idle gaps (no agent busy while run active)");
  for (const gap of report.idleGaps.slice(0, 8)) {
    lines.push(`- ${fmt(gap.durationMs)} after ${gap.afterNode} → before ${gap.beforeNode}`);
  }
  lines.push("");
  return lines.join("\n");
}

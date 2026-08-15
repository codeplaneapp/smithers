/**
 * Pure token-usage and duration prediction for the /monitor gateway UI.
 *
 * The estimates deliberately use only evidence already present in a run. A
 * missing rate or duration remains unknown so the UI never presents a made-up
 * forecast as observed data.
 */

/** Minimal view of the engine's `TokenUsageReported` event. */
export type TokenUsageEvent = {
  nodeId: string;
  iteration?: number;
  attempt?: number;
  model?: string;
  agent?: string;
  inputTokens?: number;
  freshInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number | null;
  timestampMs?: number;
};

/** Minimal timing view of a node-state row. */
export type NodeTiming = {
  nodeId: string;
  iteration?: number;
  attempt?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  status?: string;
};

/** Minimal structural view of a monitor execution-tree node. */
export type TreeNode = {
  key?: string;
  id?: string;
  kind?: string;
  status?: string;
  agent?: { model?: string } | null;
  children?: readonly TreeNode[] | null;
};

/** Aggregated reported tokens, including canonical `iteration:attempt` buckets. */
export type TokenUsageFold = {
  perNode: Map<string, number>;
  perAgent: Map<string, number>;
  perModel: Map<string, number>;
  perNodeAttempts: Map<string, Map<string, number>>;
  grandTotal: number;
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  eventCount: number;
};

/** Median observed throughput for one grouping of completed attempts. */
export type ThroughputRate = {
  outputTokensPerSecond: number;
  totalTokensPerSecond: number;
};

/**
 * Completed-attempt throughput medians and the model associated with each
 * observed node. `rateForNode` applies the node → model → global fallback.
 */
export type RateModel = {
  perNode: Map<string, ThroughputRate>;
  perModel: Map<string, ThroughputRate>;
  global: ThroughputRate | undefined;
  modelByNode: Map<string, string>;
};

/** Interquartile duration estimate in milliseconds. */
export type DurationPrediction = {
  low: number;
  median: number;
  high: number;
};

/** Usage and duration evidence available for one logical task node. */
export type NodeUsagePrediction = {
  spent: number;
  inFlight?: number;
  predictedDurationMs?: DurationPrediction;
};

/** Evidence-based token and ETA range for a run. */
export type RunUsagePrediction = {
  spentTokens: number;
  inFlightTokens: number | undefined;
  predictedTotalLow: number;
  predictedTotalHigh: number;
  etaLowMs: number | undefined;
  etaHighMs: number | undefined;
  confidence: "high" | "medium" | "low";
  perNode: Map<string, NodeUsagePrediction>;
};

/**
 * Total input/output are the two disjoint top-level counters. Cache and
 * reasoning values are breakdowns of those counters and must not be added
 * again (#1436).
 */
export function totalTokensOf(event: TokenUsageEvent): number {
  return (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
}

function attemptKey(iteration: number | undefined, attempt: number | undefined): string {
  return `${iteration ?? 0}:${attempt ?? 0}`;
}

function executionKey(nodeId: string, iteration: number | undefined, attempt: number | undefined): string {
  return `${nodeId}\u0000${attemptKey(iteration, attempt)}`;
}

/**
 * Old runtimes emitted cumulative usage repeatedly during one attempt. Keep
 * only its last record; current runtimes already emit exactly one final row.
 */
export function latestTokenUsageByAttempt(events: readonly TokenUsageEvent[]): TokenUsageEvent[] {
  const latest = new Map<string, TokenUsageEvent>();
  for (const event of events) latest.set(executionKey(event.nodeId, event.iteration, event.attempt), event);
  return [...latest.values()];
}

function increment<K>(map: Map<K, number>, key: K, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** Fold reported usage into run, node, agent, model, and attempt totals. */
export function foldTokenUsage(events: readonly TokenUsageEvent[]): TokenUsageFold {
  const perNode = new Map<string, number>();
  const perAgent = new Map<string, number>();
  const perModel = new Map<string, number>();
  const perNodeAttempts = new Map<string, Map<string, number>>();
  let grandTotal = 0;
  let freshInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let pricedEvents = 0;

  const latestEvents = latestTokenUsageByAttempt(events);
  for (const event of latestEvents) {
    const total = totalTokensOf(event);
    grandTotal += total;
    freshInputTokens += event.freshInputTokens ?? event.inputTokens ?? 0;
    cacheReadTokens += event.cacheReadTokens ?? 0;
    cacheWriteTokens += event.cacheWriteTokens ?? 0;
    if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
      costUsd += event.costUsd;
      pricedEvents += 1;
    }
    increment(perNode, event.nodeId, total);
    if (event.agent !== undefined) increment(perAgent, event.agent, total);
    if (event.model !== undefined) increment(perModel, event.model, total);

    let attempts = perNodeAttempts.get(event.nodeId);
    if (!attempts) {
      attempts = new Map<string, number>();
      perNodeAttempts.set(event.nodeId, attempts);
    }
    increment(attempts, attemptKey(event.iteration, event.attempt), total);
  }

  return {
    perNode,
    perAgent,
    perModel,
    perNodeAttempts,
    grandTotal,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: latestEvents.length > 0 && pricedEvents === latestEvents.length ? costUsd : null,
    eventCount: latestEvents.length,
  };
}

function quantile(values: readonly number[], fraction: number): number | undefined {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[upper]!;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

type AttemptTokens = {
  nodeId: string;
  model?: string;
  outputTokens: number;
  totalTokens: number;
};

type RateSample = {
  outputTokensPerSecond: number;
  totalTokensPerSecond: number;
};

function addRateSample(map: Map<string, RateSample[]>, key: string, sample: RateSample): void {
  const samples = map.get(key);
  if (samples) samples.push(sample);
  else map.set(key, [sample]);
}

function medianRate(samples: readonly RateSample[]): ThroughputRate | undefined {
  const outputTokensPerSecond = quantile(
    samples.map((sample) => sample.outputTokensPerSecond),
    0.5,
  );
  const totalTokensPerSecond = quantile(
    samples.map((sample) => sample.totalTokensPerSecond),
    0.5,
  );
  if (outputTokensPerSecond === undefined || totalTokensPerSecond === undefined) return undefined;
  return { outputTokensPerSecond, totalTokensPerSecond };
}

/**
 * Build outlier-resistant throughput medians from completed attempts whose
 * token event and timing row share a node, iteration, and attempt identity.
 * Zero-length or backwards timing windows are ignored.
 */
export function buildRateModel(events: readonly TokenUsageEvent[], timings: readonly NodeTiming[]): RateModel {
  const modelByNode = new Map<string, string>();
  const tokensByAttempt = new Map<string, AttemptTokens>();

  for (const event of latestTokenUsageByAttempt(events)) {
    if (event.model !== undefined) modelByNode.set(event.nodeId, event.model);
    const key = executionKey(event.nodeId, event.iteration, event.attempt);
    const existing = tokensByAttempt.get(key);
    if (existing) {
      existing.outputTokens += event.outputTokens ?? 0;
      existing.totalTokens += totalTokensOf(event);
      if (event.model !== undefined) existing.model = event.model;
    } else {
      tokensByAttempt.set(key, {
        nodeId: event.nodeId,
        ...(event.model !== undefined ? { model: event.model } : {}),
        outputTokens: event.outputTokens ?? 0,
        totalTokens: totalTokensOf(event),
      });
    }
  }

  const completedTimings = new Map<string, NodeTiming>();
  for (const timing of timings) {
    if (
      timing.startedAtMs === undefined ||
      timing.finishedAtMs === undefined ||
      timing.finishedAtMs <= timing.startedAtMs
    ) {
      continue;
    }
    completedTimings.set(executionKey(timing.nodeId, timing.iteration, timing.attempt), timing);
  }

  const nodeSamples = new Map<string, RateSample[]>();
  const modelSamples = new Map<string, RateSample[]>();
  const globalSamples: RateSample[] = [];
  for (const [key, tokens] of tokensByAttempt) {
    const timing = completedTimings.get(key);
    if (!timing) continue;
    const seconds = (timing.finishedAtMs! - timing.startedAtMs!) / 1_000;
    const sample = {
      outputTokensPerSecond: tokens.outputTokens / seconds,
      totalTokensPerSecond: tokens.totalTokens / seconds,
    };
    if (!Number.isFinite(sample.outputTokensPerSecond) || !Number.isFinite(sample.totalTokensPerSecond)) continue;
    addRateSample(nodeSamples, tokens.nodeId, sample);
    if (tokens.model !== undefined) addRateSample(modelSamples, tokens.model, sample);
    globalSamples.push(sample);
  }

  const perNode = new Map<string, ThroughputRate>();
  for (const [nodeId, samples] of nodeSamples) {
    const rate = medianRate(samples);
    if (rate) perNode.set(nodeId, rate);
  }
  const perModel = new Map<string, ThroughputRate>();
  for (const [model, samples] of modelSamples) {
    const rate = medianRate(samples);
    if (rate) perModel.set(model, rate);
  }

  return { perNode, perModel, global: medianRate(globalSamples), modelByNode };
}

/** Resolve the best throughput evidence for a node: node, model, then run. */
export function rateForNode(nodeId: string, rates: RateModel): ThroughputRate | undefined {
  return (
    rates.perNode.get(nodeId) ??
    (rates.modelByNode.get(nodeId) ? rates.perModel.get(rates.modelByNode.get(nodeId)!) : undefined) ??
    rates.global
  );
}

/** Estimate unreported in-flight spend from elapsed wall time and the best rate. */
export function estimateInFlight(nodeId: string, elapsedMs: number, rates: RateModel): number | undefined {
  const rate = rateForNode(nodeId, rates);
  if (!rate || !Number.isFinite(elapsedMs)) return undefined;
  return (Math.max(0, elapsedMs) * rate.totalTokensPerSecond) / 1_000;
}

/**
 * Predict a node duration from its completed attempts. The p25/median/p75
 * quantiles use linear interpolation; fewer than two samples stays unknown.
 */
export function predictNodeDurationMs(nodeId: string, timings: readonly NodeTiming[]): DurationPrediction | undefined {
  const durations = timings
    .filter(
      (timing) =>
        timing.nodeId === nodeId &&
        timing.startedAtMs !== undefined &&
        timing.finishedAtMs !== undefined &&
        timing.finishedAtMs >= timing.startedAtMs,
    )
    .map((timing) => timing.finishedAtMs! - timing.startedAtMs!);
  if (durations.length < 2) return undefined;
  const low = quantile(durations, 0.25);
  const median = quantile(durations, 0.5);
  const high = quantile(durations, 0.75);
  if (low === undefined || median === undefined || high === undefined) return undefined;
  return { low, median, high };
}

const TASK_KINDS = new Set(["task", "agent", "compute", "static"]);
const PENDING_STATUSES = new Set(["", "pending", "queued", "not-started", "idle"]);
const TERMINAL_STATUSES = new Set(["finished", "failed", "stalled", "cancelled", "skipped", "cached"]);

type LeafWork = { nodeId: string; status: string; model?: string };

function normalizedStatus(status: string | undefined): string {
  return (status ?? "").trim().toLowerCase().replaceAll("_", "-");
}

function treeLeaves(tree: TreeNode | readonly TreeNode[] | null | undefined): {
  leaves: LeafWork[];
  allIds: Set<string>;
} {
  const leaves: LeafWork[] = [];
  const allIds = new Set<string>();
  const roots = Array.isArray(tree) ? tree : tree ? [tree] : [];

  const visit = (node: TreeNode): void => {
    const nodeId = node.id ?? node.key;
    if (nodeId) allIds.add(nodeId);
    const children = node.children ?? [];
    for (const child of children) visit(child);
    if (children.length > 0 || !nodeId) return;
    const kind = (node.kind ?? "").toLowerCase();
    if (kind && !TASK_KINDS.has(kind)) return;
    leaves.push({
      nodeId,
      status: normalizedStatus(node.status),
      ...(node.agent?.model ? { model: node.agent.model } : {}),
    });
  };
  for (const root of roots) visit(root);
  return { leaves, allIds };
}

function maxObservedConcurrency(
  timings: readonly NodeTiming[],
  nowMs: number,
  treeIds: ReadonlySet<string>,
  leafIds: ReadonlySet<string>,
  live: boolean,
): number {
  const edges: Array<{ at: number; delta: -1 | 1 }> = [];
  for (const timing of timings) {
    if (timing.startedAtMs === undefined) continue;
    if (treeIds.has(timing.nodeId) && !leafIds.has(timing.nodeId)) continue;
    if (
      timing.finishedAtMs === undefined &&
      (!live || (timing.status !== undefined && TERMINAL_STATUSES.has(normalizedStatus(timing.status))))
    )
      continue;
    const end = timing.finishedAtMs ?? nowMs;
    if (end <= timing.startedAtMs) continue;
    edges.push({ at: timing.startedAtMs, delta: 1 }, { at: end, delta: -1 });
  }
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let maximum = 0;
  for (const edge of edges) {
    active += edge.delta;
    maximum = Math.max(maximum, active);
  }
  return Math.max(1, maximum);
}

function tokenSamplesFor(fold: TokenUsageFold, nodeId: string): number[] {
  return [...(fold.perNodeAttempts.get(nodeId)?.values() ?? [])];
}

type RunningWork = { nodeId: string; startedAtMs?: number };

/**
 * Predict run spend and ETA from this run's own history. Pending token ranges
 * use per-attempt p25/p75 values. ETA adds remaining running time and pending
 * duration ranges, then divides those serial sums by the maximum task
 * concurrency observed in timing-window overlaps (default one). Any unknown
 * duration makes ETA unknown; unknown token contributions are omitted from the
 * required numeric bounds and reduce confidence instead.
 */
export function predictRunUsage(input: {
  events: readonly TokenUsageEvent[];
  timings: readonly NodeTiming[];
  tree: TreeNode | readonly TreeNode[] | null | undefined;
  nowMs: number;
  /** Set false for settled runs so orphaned started rows cannot look active. */
  live?: boolean;
}): RunUsagePrediction {
  const live = input.live !== false;
  const fold = foldTokenUsage(input.events);
  const builtRates = buildRateModel(input.events, input.timings);
  const { leaves, allIds: treeIds } = treeLeaves(input.tree);
  const leafIds = new Set(leaves.map((leaf) => leaf.nodeId));
  const modelByNode = new Map(builtRates.modelByNode);
  for (const leaf of leaves) if (leaf.model) modelByNode.set(leaf.nodeId, leaf.model);
  const rates: RateModel = { ...builtRates, modelByNode };

  const activeTimings = new Map<string, NodeTiming>();
  for (const timing of input.timings) {
    if (!live) continue;
    if (timing.startedAtMs === undefined || timing.finishedAtMs !== undefined) continue;
    if (timing.status !== undefined && TERMINAL_STATUSES.has(normalizedStatus(timing.status))) continue;
    if (treeIds.has(timing.nodeId) && !leafIds.has(timing.nodeId)) continue;
    activeTimings.set(executionKey(timing.nodeId, timing.iteration, timing.attempt), timing);
  }
  const running: RunningWork[] = [...activeTimings.values()].map((timing) => ({
    nodeId: timing.nodeId,
    startedAtMs: timing.startedAtMs,
  }));

  const activeCounts = new Map<string, number>();
  for (const item of running) increment(activeCounts, item.nodeId, 1);
  const treeRunningCounts = new Map<string, number>();
  for (const leaf of live ? leaves : []) {
    if (leaf.status === "running") increment(treeRunningCounts, leaf.nodeId, 1);
  }
  for (const [nodeId, count] of treeRunningCounts) {
    const missing = Math.max(0, count - (activeCounts.get(nodeId) ?? 0));
    for (let index = 0; index < missing; index += 1) running.push({ nodeId });
  }

  const activeSurplus = new Map<string, number>();
  for (const [nodeId, count] of activeCounts) {
    activeSurplus.set(nodeId, Math.max(0, count - (treeRunningCounts.get(nodeId) ?? 0)));
  }
  const pending: LeafWork[] = [];
  for (const leaf of live ? leaves : []) {
    if (!PENDING_STATUSES.has(leaf.status)) continue;
    const surplus = activeSurplus.get(leaf.nodeId) ?? 0;
    if (surplus > 0) activeSurplus.set(leaf.nodeId, surplus - 1);
    else pending.push(leaf);
  }

  const inFlightEstimates = running.map((item) =>
    item.startedAtMs === undefined
      ? undefined
      : estimateInFlight(item.nodeId, Math.max(0, input.nowMs - item.startedAtMs), rates),
  );
  const inFlightTokens = !live
    ? undefined
    : inFlightEstimates.some((estimate) => estimate === undefined)
      ? undefined
      : inFlightEstimates.reduce<number>((sum, estimate) => sum + estimate!, 0);

  let pendingLow = 0;
  let pendingHigh = 0;
  for (const item of pending) {
    const samples = tokenSamplesFor(fold, item.nodeId);
    pendingLow += quantile(samples, 0.25) ?? 0;
    pendingHigh += quantile(samples, 0.75) ?? 0;
  }
  const knownInFlight = inFlightTokens ?? 0;
  const predictedTotalLow = live ? fold.grandTotal + knownInFlight + pendingLow : fold.grandTotal;
  const predictedTotalHigh = live ? fold.grandTotal + knownInFlight + pendingHigh : fold.grandTotal;

  let etaLowSerial = 0;
  let etaHighSerial = 0;
  let etaKnown = true;
  for (const item of running) {
    const duration = predictNodeDurationMs(item.nodeId, input.timings);
    if (!duration || item.startedAtMs === undefined) {
      etaKnown = false;
      continue;
    }
    const elapsed = Math.max(0, input.nowMs - item.startedAtMs);
    etaLowSerial += Math.max(0, duration.low - elapsed);
    etaHighSerial += Math.max(0, duration.high - elapsed);
  }
  for (const item of pending) {
    const duration = predictNodeDurationMs(item.nodeId, input.timings);
    if (!duration) {
      etaKnown = false;
      continue;
    }
    etaLowSerial += duration.low;
    etaHighSerial += duration.high;
  }
  const concurrency = maxObservedConcurrency(input.timings, input.nowMs, treeIds, leafIds, live);
  const etaLowMs = live && etaKnown ? etaLowSerial / concurrency : undefined;
  const etaHighMs = live && etaKnown ? etaHighSerial / concurrency : undefined;

  const remaining = [...running, ...pending];
  const sampled = remaining.filter((item) => tokenSamplesFor(fold, item.nodeId).length > 0).length;
  const coverage = remaining.length === 0 ? 1 : sampled / remaining.length;
  const confidence = coverage >= 0.8 ? "high" : coverage >= 0.5 ? "medium" : "low";

  const nodeIds = new Set<string>([
    ...fold.perNode.keys(),
    ...input.timings.map((timing) => timing.nodeId),
    ...leaves.map((leaf) => leaf.nodeId),
  ]);
  const estimatesByNode = new Map<string, Array<number | undefined>>();
  running.forEach((item, index) => {
    const estimates = estimatesByNode.get(item.nodeId);
    if (estimates) estimates.push(inFlightEstimates[index]);
    else estimatesByNode.set(item.nodeId, [inFlightEstimates[index]]);
  });
  const perNode = new Map<string, NodeUsagePrediction>();
  for (const nodeId of nodeIds) {
    const duration = predictNodeDurationMs(nodeId, input.timings);
    const estimates = estimatesByNode.get(nodeId);
    const nodeInFlight =
      estimates && !estimates.some((estimate) => estimate === undefined)
        ? estimates.reduce<number>((sum, estimate) => sum + estimate!, 0)
        : undefined;
    perNode.set(nodeId, {
      spent: fold.perNode.get(nodeId) ?? 0,
      ...(nodeInFlight !== undefined ? { inFlight: nodeInFlight } : {}),
      ...(duration ? { predictedDurationMs: duration } : {}),
    });
  }

  return {
    spentTokens: fold.grandTotal,
    inFlightTokens,
    predictedTotalLow,
    predictedTotalHigh,
    etaLowMs,
    etaHighMs,
    confidence,
    perNode,
  };
}
function compact(value: number, divisor: number, suffix: string): string {
  const rounded = Math.round((value / divisor) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
}

/** Format token counts compactly for monitor labels. */
export function formatTokens(tokens: number): string {
  const absolute = Math.abs(tokens);
  if (absolute < 1_000) return Math.round(tokens).toString();
  if (absolute < 1_000_000) return compact(tokens, 1_000, "k");
  if (absolute < 1_000_000_000) return compact(tokens, 1_000_000, "M");
  return compact(tokens, 1_000_000_000, "B");
}

/**
 * Compact token range for predicted totals: shares the unit suffix when both
 * bounds use it ("260–340k"), keeps both otherwise ("800–1.5k"). Equal bounds
 * collapse to one value so a settled range never reads as a span.
 */
export function formatTokenRange(low: number, high: number): string {
  const lowText = formatTokens(low);
  const highText = formatTokens(high);
  if (lowText === highText) return lowText;
  const suffix = /[kMB]$/.exec(highText)?.[0];
  if (suffix && lowText.endsWith(suffix)) return `${lowText.slice(0, -1)}–${highText}`;
  return `${lowText}–${highText}`;
}

/** Tokens reported inside one fixed-width time bucket of the burn series. */
export type TokenBurnBucket = {
  /** Epoch ms at the bucket's left edge (aligned to `bucketMs`). */
  startMs: number;
  tokens: number;
};

/**
 * Per-bucket token burn over the trailing window: `bucketCount` aligned
 * buckets ending at the bucket containing `nowMs`. Events without a
 * timestamp cannot be placed in time and are skipped — the series only ever
 * shows measured spend, never an estimate.
 */
export function tokenBurnBuckets(
  events: readonly TokenUsageEvent[],
  bucketMs: number,
  nowMs: number,
  bucketCount = 30,
): TokenBurnBucket[] {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0 || !Number.isFinite(bucketCount) || bucketCount <= 0) {
    return [];
  }
  const lastStart = Math.floor(nowMs / bucketMs) * bucketMs;
  const firstStart = lastStart - (bucketCount - 1) * bucketMs;
  const totals = new Map<number, number>();
  for (const event of latestTokenUsageByAttempt(events)) {
    if (event.timestampMs === undefined) continue;
    const start = Math.floor(event.timestampMs / bucketMs) * bucketMs;
    if (start < firstStart || start > lastStart) continue;
    increment(totals, start, totalTokensOf(event));
  }
  const buckets: TokenBurnBucket[] = [];
  for (let start = firstStart; start <= lastStart; start += bucketMs) {
    buckets.push({ startMs: start, tokens: totals.get(start) ?? 0 });
  }
  return buckets;
}

/**
 * Subtree rollup of per-node totals over a monitor execution tree: every node
 * maps to its own total plus all descendants', keyed by `id ?? key` (the same
 * convention as the fold's per-node keys). Loop iterations reusing one logical
 * id each contribute the shared per-id total — an accepted approximation, so
 * repeated ids accumulate instead of overwriting.
 */
export function subtreeTokenTotals(
  tree: TreeNode | readonly TreeNode[] | null | undefined,
  perNode: ReadonlyMap<string, number>,
): Map<string, number> {
  const totals = new Map<string, number>();
  const visit = (node: TreeNode): number => {
    const nodeId = node.id ?? node.key;
    let sum = nodeId !== undefined ? (perNode.get(nodeId) ?? 0) : 0;
    for (const child of node.children ?? []) sum += visit(child);
    if (nodeId !== undefined) totals.set(nodeId, (totals.get(nodeId) ?? 0) + sum);
    return sum;
  };
  const roots = Array.isArray(tree) ? tree : tree ? [tree] : [];
  for (const root of roots) visit(root);
  return totals;
}

/** One attempt's contribution inside a node's usage breakdown. */
export type NodeAttemptUsage = {
  iteration?: number;
  attempt?: number;
  model?: string;
  total: number;
};

/** Per-counter totals and per-attempt rows for one node. */
export type NodeUsageBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  attempts: NodeAttemptUsage[];
};

/**
 * Everything the node inspector shows for one node: summed counters plus a
 * per-(iteration, attempt) breakdown with the model seen on each. Undefined
 * when the node reported no usage at all, so the UI can stay silent.
 */
export function nodeUsageBreakdown(events: readonly TokenUsageEvent[], nodeId: string): NodeUsageBreakdown | undefined {
  let found = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  const byAttempt = new Map<string, NodeAttemptUsage>();
  for (const event of latestTokenUsageByAttempt(events)) {
    if (event.nodeId !== nodeId) continue;
    found = true;
    input += event.inputTokens ?? 0;
    output += event.outputTokens ?? 0;
    cacheRead += event.cacheReadTokens ?? 0;
    cacheWrite += event.cacheWriteTokens ?? 0;
    reasoning += event.reasoningTokens ?? 0;
    const key = attemptKey(event.iteration, event.attempt);
    const existing = byAttempt.get(key);
    if (existing) {
      existing.total += totalTokensOf(event);
      if (event.model !== undefined) existing.model = event.model;
    } else {
      byAttempt.set(key, {
        ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
        ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        total: totalTokensOf(event),
      });
    }
  }
  if (!found) return undefined;
  const attempts = [...byAttempt.values()].sort(
    (left, right) => (left.iteration ?? 0) - (right.iteration ?? 0) || (left.attempt ?? 0) - (right.attempt ?? 0),
  );
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: input + output,
    attempts,
  };
}

export type TrellisRunNode = {
  id: string;
  iteration?: number;
  status?: string;
  meta?: string;
};

export type TrellisRunEvent = {
  seq?: number;
  event?: string;
  payload?: unknown;
};

export type TrellisMeta = {
  phase?: string;
  logicalId?: string;
  role?: string;
  work?: string;
  generation?: number;
  programId?: string;
  criticalExecutionPolicyHash?: string;
  criticalExecutionGrantHash?: string;
  rootMaxConcurrency?: number;
  rootAuthorTurnsTotal?: number;
  rootMaxAuthorGenerations?: number;
  rootMaxAuthorDepth?: number;
  invocationAuthorTurnsAllocated?: number;
  invocationAuthorTurnsRemaining?: number;
};

export type TrellisRunTruth = {
  rootMaxConcurrency: number;
  rootAuthorTurnsTotal: number;
  rootMaxAuthorGenerations?: number;
  rootMaxAuthorDepth?: number;
  rootAuthorTurnsAllocated?: number;
  /** Remaining fuel in the root invocation's immutable allocation, not a global counter. */
  rootAuthorTurnsRemaining?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OUTPUT_TERMINAL_EVENTS = new Set([
  "NodeFinished",
  "NodeFailed",
  "NodeCancelled",
  "NodeSkipped",
  "node.finished",
  "node.failed",
  "node.cancelled",
  "node.skipped",
]);

/**
 * Produce a stable invalidation token for an RPC-backed node output.
 *
 * The run tree supplies live status while the event collection supplies a
 * durable terminal tick. Combining both covers either source arriving first
 * without refetching for unrelated nodes.
 */
export function trellisNodeOutputRevision(
  node: TrellisRunNode | undefined,
  events: readonly TrellisRunEvent[],
): string {
  if (!node) return "disabled";
  const iteration = node.iteration ?? 0;
  let terminalSeq = 0;
  for (let index = 0; index < events.length; index += 1) {
    const frame = events[index];
    if (!frame || !OUTPUT_TERMINAL_EVENTS.has(frame.event ?? "")) continue;
    const payload = isRecord(frame.payload) ? frame.payload : undefined;
    if (payload?.nodeId !== node.id) continue;
    if (typeof payload.iteration === "number" && payload.iteration !== iteration) continue;
    const seq = typeof frame.seq === "number" ? frame.seq : index + 1;
    terminalSeq = Math.max(terminalSeq, seq);
  }
  return `${node.status ?? "unknown"}:${terminalSeq}`;
}

/** Read only trusted Trellis metadata; never infer semantics from physical IDs. */
export function trellisMetaOf(node: TrellisRunNode): TrellisMeta | undefined {
  if (!node.meta) return undefined;
  try {
    const parsed = JSON.parse(node.meta);
    return isRecord(parsed) && isRecord(parsed.trellis) ? (parsed.trellis as TrellisMeta) : undefined;
  } catch {
    return undefined;
  }
}

export function findTrellisNodeByPhase<T extends TrellisRunNode>(nodes: readonly T[], phase: string): T | undefined {
  return nodes.find((node) => trellisMetaOf(node)?.phase === phase);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/**
 * Recover persisted limits for the selected run without consulting launcher
 * controls. Terminal metadata wins for fixed run settings; the smallest root
 * invocation remainder is the latest monotonic local-fuel observation.
 */
export function trellisRunTruthOf(nodes: readonly TrellisRunNode[]): TrellisRunTruth | undefined {
  const metas = nodes.map(trellisMetaOf).filter((meta): meta is TrellisMeta => meta !== undefined);
  const rootMetas = metas.filter((meta) => meta.logicalId === "root");
  const settings =
    rootMetas.find((meta) => meta.phase === "final") ??
    rootMetas.find((meta) => meta.phase === "initial") ??
    rootMetas[0];
  const rootMaxConcurrency = positiveInteger(settings?.rootMaxConcurrency);
  const rootAuthorTurnsTotal = positiveInteger(settings?.rootAuthorTurnsTotal);
  if (rootMaxConcurrency === undefined || rootAuthorTurnsTotal === undefined) return undefined;

  const allocated = rootMetas
    .map((meta) => positiveInteger(meta.invocationAuthorTurnsAllocated))
    .find((value) => value !== undefined);
  const remainingValues = rootMetas
    .map((meta) => nonNegativeInteger(meta.invocationAuthorTurnsRemaining))
    .filter((value): value is number => value !== undefined);
  const remaining = remainingValues.length > 0 ? Math.min(...remainingValues) : undefined;
  const generations = positiveInteger(settings.rootMaxAuthorGenerations);
  const depth = positiveInteger(settings.rootMaxAuthorDepth);

  return {
    rootMaxConcurrency,
    rootAuthorTurnsTotal,
    ...(generations === undefined ? {} : { rootMaxAuthorGenerations: generations }),
    ...(depth === undefined ? {} : { rootMaxAuthorDepth: depth }),
    ...(allocated === undefined ? {} : { rootAuthorTurnsAllocated: allocated }),
    ...(remaining === undefined ? {} : { rootAuthorTurnsRemaining: remaining }),
  };
}

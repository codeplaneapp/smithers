/**
 * Effect-native record-assembly pipeline behind `useDelegationChain`.
 *
 * The pipeline is a small state machine: React pushes input batches (run-tree
 * nodes, live event frames, approvals) into a `Queue`; a single consumer
 * fiber drains it as a `Stream`, dispatching each message with
 * `Match.tagsExhaustive` and reconciling Effect-managed state (`Ref`s for the
 * durable event-derived fetch targets, the (nodeId, iteration) output cache,
 * the in-flight dedup set, and hydration) into a
 * `SubscriptionRef<DelegationChainSnapshot>`. Each processed message publishes
 * AT MOST one snapshot update (none when nothing changed), so a batch of new
 * events never fans out into per-row renders. The React hook subscribes via
 * `useSyncExternalStore`.
 *
 * Assembly semantics are the frozen pre-Effect behavior:
 * - Fetch targets are the union of the CURRENT run tree and the durable
 *   run-event history (`delegationTargetsFromEvents` — one-shot paged
 *   `listRunEvents` backfill plus live-frame accumulation), so loop
 *   iterations the tree already replaced survive reloads and late joins.
 * - `getNodeOutput` fetches each (nodeId, iteration) exactly once; a missing
 *   or errored output is re-fetched only when a finish event for that node
 *   arrives (event-driven invalidation), never on every frame.
 * - The pure `foldDelegation` reducer turns the assembled records into the
 *   graph; malformed/unknown rows surface as errors instead of throwing.
 */

import { Data, Effect, Exit, Fiber, Match, Queue, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { GatewayRpcError } from "@smithers-orchestrator/gateway-client";
import {
  delegationTargetKey,
  delegationTargetsFromEvents,
  type DelegationFetchTarget,
} from "./delegationEventTargets.ts";
import {
  delegationTableForNodeId,
  foldDelegation,
  parseDelegationNodeId,
  type DelegationFoldIssue,
} from "./foldDelegation.ts";
import type {
  DelegationApprovalRecord,
  DelegationGraph,
  DelegationOutputRecord,
  DelegationRecord,
} from "./types.ts";

/** Output error codes that just mean "nothing durable yet" — retry later. */
const EXPECTED_OUTPUT_ERRORS = new Set(["NodeHasNoOutput", "NodeNotFound", "IterationNotFound", "RunNotFound"]);

/** Page size for the one-shot run-event history backfill. */
export const EVENT_HISTORY_PAGE_SIZE = 500;

/**
 * The two gateway RPCs the pipeline needs, stated structurally so the real
 * `SmithersApi` satisfies it and tests can seed a deterministic fixture.
 */
export type DelegationChainApi = {
  listRunEvents(params: {
    runId: string;
    limit: number;
    afterSeq?: number;
  }): Promise<ReadonlyArray<{ seq?: number; event: string; payload?: unknown }>>;
  getNodeOutput(params: { runId: string; nodeId: string; iteration: number }): Promise<unknown>;
};

/** One React-side input batch (pushed whenever any of the sources change). */
export type DelegationChainInputs = {
  treeNodes: ReadonlyArray<{ id: string; iteration?: number | undefined }>;
  treeLoading: boolean;
  events: ReadonlyArray<{ event: string; payload?: unknown }>;
  approvals: ReadonlyArray<{ runId: string; nodeId: string; iteration: number }>;
};

/** What the SubscriptionRef publishes and `useSyncExternalStore` reads. */
export type DelegationChainSnapshot = {
  graph: DelegationGraph;
  /** Fold issues + output-fetch errors, in fold-then-fetch order. */
  recordErrors: ReadonlyArray<unknown>;
  historyError: Error | undefined;
  /** True once every currently-known target has been fetched at least once. */
  hydrated: boolean;
  /** Number of known (nodeId, iteration) fetch targets (tree ∪ durable). */
  targetCount: number;
};

export type DelegationChainStore = {
  /** Push a fresh input batch; processed asynchronously by the consumer fiber. */
  push(inputs: DelegationChainInputs): void;
  /** `useSyncExternalStore` subscribe: fires on every snapshot publish. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): DelegationChainSnapshot;
  /** Interrupt all fibers (consumer, backfill, in-flight fetches). Idempotent. */
  dispose(): void;
  readonly disposed: boolean;
};

type OutputCacheEntry =
  | { state: "produced"; record: DelegationOutputRecord }
  | { state: "missing"; finishCount: number }
  | { state: "error"; finishCount: number; error: Error };

type StoreMessage = Data.TaggedEnum<{
  /** React pushed a new input batch. */
  InputsChanged: { readonly inputs: DelegationChainInputs };
  /** The one-shot durable event-history backfill finished (or failed partway). */
  HistoryLoaded: {
    readonly targets: ReadonlyMap<string, DelegationFetchTarget>;
    readonly error: Error | undefined;
  };
  /** A parallel `getNodeOutput` batch settled. */
  OutputsSettled: {
    readonly results: ReadonlyArray<{ readonly key: string; readonly entry: OutputCacheEntry }>;
  };
}>;
const StoreMessage = Data.taggedEnum<StoreMessage>();

const INITIAL_INPUTS: DelegationChainInputs = {
  treeNodes: [],
  treeLoading: true,
  events: [],
  approvals: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge new fetch targets into an existing map; returns the same map when nothing is new. */
function mergeTargets(
  previous: ReadonlyMap<string, DelegationFetchTarget>,
  found: ReadonlyMap<string, DelegationFetchTarget>,
): ReadonlyMap<string, DelegationFetchTarget> {
  let next: Map<string, DelegationFetchTarget> | null = null;
  for (const [key, target] of found) {
    if (previous.has(key)) continue;
    (next ??= new Map(previous)).set(key, target);
  }
  return next ?? previous;
}

/**
 * Completion ticks per node id, so missing outputs are only refetched when
 * something actually finished (not on every event frame). Durable history
 * rows carry the persisted engine type (`NodeFinished`); live wire frames
 * use `node.finished` — accept both spellings.
 */
function countFinishes(events: ReadonlyArray<{ event: string; payload?: unknown }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const frame of events) {
    if (
      frame.event !== "node.finished" && frame.event !== "NodeFinished" &&
      frame.event !== "node.failed" && frame.event !== "NodeFailed"
    ) continue;
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : undefined;
    if (!nodeId) continue;
    counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  }
  return counts;
}

type FoldMemo = {
  cache: ReadonlyMap<string, OutputCacheEntry>;
  approvals: DelegationChainInputs["approvals"];
  graph: DelegationGraph;
  recordErrors: ReadonlyArray<unknown>;
};

export function createDelegationChainStore(options: {
  runId: string | undefined;
  api: DelegationChainApi;
}): DelegationChainStore {
  const { runId, api } = options;
  return Effect.runSync(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const queue = yield* Queue.unbounded<StoreMessage>();
      const inputs = yield* Ref.make<DelegationChainInputs>(INITIAL_INPUTS);
      const eventTargets = yield* Ref.make<ReadonlyMap<string, DelegationFetchTarget>>(new Map());
      const cache = yield* Ref.make<ReadonlyMap<string, OutputCacheEntry>>(new Map());
      const inFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
      const hydrated = yield* Ref.make(false);
      const historyError = yield* Ref.make<Error | undefined>(undefined);
      const foldMemo = yield* Ref.make<FoldMemo | undefined>(undefined);
      const snapshot = yield* SubscriptionRef.make<DelegationChainSnapshot>({
        graph: foldDelegation([]),
        recordErrors: [],
        historyError: undefined,
        hydrated: false,
        targetCount: 0,
      });

      /** Fold the cached records (+ approvals) — memoized on input identity. */
      const foldRecords = Effect.gen(function* () {
        const cacheNow = yield* Ref.get(cache);
        const approvalsNow = (yield* Ref.get(inputs)).approvals;
        const memo = yield* Ref.get(foldMemo);
        if (memo && memo.cache === cacheNow && memo.approvals === approvalsNow) return memo;
        const records: DelegationRecord[] = [];
        for (const entry of cacheNow.values()) {
          if (entry.state === "produced") records.push(entry.record);
        }
        for (const approval of runId !== undefined ? approvalsNow : []) {
          if (approval.runId !== runId) continue;
          // Accept any delegation node that can carry a HumanTask/Approval:
          // nodes with an output table (question-<seq>, poll, exec, …), the
          // listener ids (dc-poll), AND the approval-only phases
          // (`dc:<goal>:approve`, `dc:<leaf>:approval-<i>`) which have no
          // output table but must still surface as awaiting-human.
          // Non-delegation node ids stay excluded.
          if (delegationTableForNodeId(approval.nodeId) === null && parseDelegationNodeId(approval.nodeId) === null) continue;
          const record: DelegationApprovalRecord = {
            table: "_approval",
            nodeId: approval.nodeId,
            iteration: approval.iteration,
            pending: true,
          };
          records.push(record);
        }
        const issues: DelegationFoldIssue[] = [];
        const graph = foldDelegation(records, { onIgnored: (issue) => issues.push(issue) });
        const recordErrors: unknown[] = [...issues];
        for (const entry of cacheNow.values()) {
          if (entry.state === "error") recordErrors.push(entry.error);
        }
        const next: FoldMemo = { cache: cacheNow, approvals: approvalsNow, graph, recordErrors };
        yield* Ref.set(foldMemo, next);
        return next;
      });

      /** Publish a new snapshot iff anything the hook renders from changed. */
      const publish = (targetCount: number) =>
        Effect.gen(function* () {
          const folded = yield* foldRecords;
          const hydratedNow = yield* Ref.get(hydrated);
          const historyErrorNow = yield* Ref.get(historyError);
          const previous = yield* Ref.get(snapshot);
          if (
            previous.graph === folded.graph &&
            previous.recordErrors === folded.recordErrors &&
            previous.historyError === historyErrorNow &&
            previous.hydrated === hydratedNow &&
            previous.targetCount === targetCount
          ) {
            return;
          }
          yield* Ref.set(snapshot, {
            graph: folded.graph,
            recordErrors: folded.recordErrors,
            historyError: historyErrorNow,
            hydrated: hydratedNow,
            targetCount,
          });
        });

      /** One parallel `getNodeOutput` batch; settles back through the queue. */
      const fetchOutputs = (
        due: ReadonlyArray<{ key: string } & DelegationFetchTarget>,
        finishCounts: ReadonlyMap<string, number>,
      ) =>
        Effect.gen(function* () {
          if (runId === undefined) return;
          const results = yield* Effect.forEach(
            due,
            ({ key, nodeId, iteration }) => {
              const finishCount = finishCounts.get(nodeId) ?? 0;
              return Effect.tryPromise({
                try: () => api.getNodeOutput({ runId, nodeId, iteration }),
                catch: (cause) => cause,
              }).pipe(
                Effect.map((response): OutputCacheEntry => {
                  const row = isRecord(response) && isRecord(response.row) ? response.row : undefined;
                  const produced = isRecord(response) && response.status === "produced" && row !== undefined;
                  return produced
                    ? {
                        state: "produced",
                        record: { table: delegationTableForNodeId(nodeId)!, nodeId, iteration, row },
                      }
                    : { state: "missing", finishCount };
                }),
                Effect.catchAll((cause): Effect.Effect<OutputCacheEntry> => {
                  const code = cause instanceof GatewayRpcError ? cause.code : undefined;
                  if (code !== undefined && EXPECTED_OUTPUT_ERRORS.has(code)) {
                    return Effect.succeed({ state: "missing", finishCount });
                  }
                  const error = cause instanceof Error ? cause : new Error(String(cause));
                  return Effect.succeed({ state: "error", finishCount, error });
                }),
                Effect.map((entry) => ({ key, entry })),
              );
            },
            { concurrency: "unbounded" },
          );
          yield* Queue.offer(queue, StoreMessage.OutputsSettled({ results }));
        });

      /**
       * Recompute targets/finish-counts, schedule due fetches (deduped via
       * the in-flight set), settle hydration, and publish the snapshot.
       */
      const reconcile = Effect.gen(function* () {
        const inputsNow = yield* Ref.get(inputs);
        // Targets: every delegation-relevant (nodeId, iteration) pair —
        // current tree positions unioned with the durable event-derived
        // history (the live event ring is bounded, so durable pairs are made
        // sticky in `eventTargets` instead of re-derived from the ring).
        const targets = new Map<string, DelegationFetchTarget>();
        for (const node of inputsNow.treeNodes) {
          if (delegationTableForNodeId(node.id) === null) continue;
          const iteration = node.iteration ?? 0;
          targets.set(delegationTargetKey(node.id, iteration), { nodeId: node.id, iteration });
        }
        for (const [key, target] of yield* Ref.get(eventTargets)) {
          if (!targets.has(key)) targets.set(key, target);
        }

        if (runId !== undefined) {
          const finishCounts = countFinishes(inputsNow.events);
          const cacheNow = yield* Ref.get(cache);
          const inFlightNow = yield* Ref.get(inFlight);
          const due: Array<{ key: string } & DelegationFetchTarget> = [];
          for (const [key, target] of targets) {
            const entry = cacheNow.get(key);
            if (entry?.state === "produced") continue;
            const finishCount = finishCounts.get(target.nodeId) ?? 0;
            if (entry && entry.finishCount >= finishCount && entry.state !== "error") continue;
            if (entry?.state === "error" && entry.finishCount >= finishCount) continue;
            if (inFlightNow.has(key)) continue;
            due.push({ key, ...target });
          }
          if (due.length > 0) {
            yield* Ref.update(inFlight, (previous) => {
              const next = new Set(previous);
              for (const item of due) next.add(item.key);
              return next;
            });
            yield* Effect.forkIn(fetchOutputs(due, finishCounts), scope);
          } else if (inFlightNow.size === 0 && !(yield* Ref.get(hydrated)) && !inputsNow.treeLoading) {
            // Only hydrate when nothing is outstanding: in-flight keys are
            // excluded from `due`, so an empty `due` with a forked fetch still
            // pending must NOT flip hydrated — OutputsSettled does that.
            yield* Ref.set(hydrated, true);
          }
        }
        yield* publish(targets.size);
      });

      const handleMessage = Match.type<StoreMessage>().pipe(
        Match.tagsExhaustive({
          InputsChanged: ({ inputs: next }) =>
            Effect.gen(function* () {
              yield* Ref.set(inputs, next);
              // Live accumulation: new lifecycle events (loop advances,
              // listener deliveries) add their (nodeId, iteration) pairs.
              const found = delegationTargetsFromEvents(next.events);
              if (found.size > 0) yield* Ref.update(eventTargets, (previous) => mergeTargets(previous, found));
              yield* reconcile;
            }),
          HistoryLoaded: ({ targets: found, error }) =>
            Effect.gen(function* () {
              if (error !== undefined) yield* Ref.set(historyError, error);
              // Keep whatever was collected even on error — the tree still
              // covers current nodes.
              if (found.size > 0) yield* Ref.update(eventTargets, (previous) => mergeTargets(previous, found));
              yield* reconcile;
            }),
          OutputsSettled: ({ results }) =>
            Effect.gen(function* () {
              yield* Ref.update(cache, (previous) => {
                const next = new Map(previous);
                for (const { key, entry } of results) next.set(key, entry);
                return next;
              });
              yield* Ref.update(inFlight, (previous) => {
                const next = new Set(previous);
                for (const { key } of results) next.delete(key);
                return next;
              });
              yield* Ref.set(hydrated, true);
              yield* reconcile;
            }),
        }),
      );

      yield* Effect.forkIn(Stream.runForEach(Stream.fromQueue(queue), handleMessage), scope);

      // Fresh-mount backfill. Mechanism choice: the gateway exposes no
      // listNodes RPC over durable node rows, but `listRunEvents` replays the
      // full append-only run-event history with `afterSeq` pagination (the
      // same surface `smithers events` uses), and every persisted node
      // lifecycle event carries `nodeId` + `iteration`. Paging it once per
      // run reconstructs ALL iterations without new RPCs and without the
      // live event ring's row bound.
      if (runId !== undefined) {
        const backfill = Effect.gen(function* () {
          const found = new Map<string, DelegationFetchTarget>();
          let error: Error | undefined;
          let afterSeq: number | undefined;
          for (;;) {
            const page = yield* Effect.tryPromise({
              try: () =>
                api.listRunEvents({
                  runId,
                  limit: EVENT_HISTORY_PAGE_SIZE,
                  ...(afterSeq === undefined ? {} : { afterSeq }),
                }),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }).pipe(
              Effect.catchAll((cause) => {
                error = cause;
                return Effect.succeed(undefined);
              }),
            );
            if (page === undefined) break;
            for (const [key, target] of delegationTargetsFromEvents(page)) found.set(key, target);
            if (page.length < EVENT_HISTORY_PAGE_SIZE) break;
            const lastSeq = page[page.length - 1]?.seq;
            // Defensive: stop rather than loop forever on a non-advancing cursor.
            if (typeof lastSeq !== "number" || (afterSeq !== undefined && lastSeq <= afterSeq)) break;
            afterSeq = lastSeq;
          }
          yield* Queue.offer(queue, StoreMessage.HistoryLoaded({ targets: found, error }));
        });
        yield* Effect.forkIn(backfill, scope);
      }

      let disposed = false;
      const store: DelegationChainStore = {
        push: (next) => {
          Queue.unsafeOffer(queue, StoreMessage.InputsChanged({ inputs: next }));
        },
        subscribe: (listener) => {
          const fiber = Effect.runFork(
            Stream.runForEach(snapshot.changes, () => Effect.sync(listener)),
          );
          return () => {
            Effect.runFork(Fiber.interrupt(fiber));
          };
        },
        getSnapshot: () => Effect.runSync(Ref.get(snapshot)),
        dispose: () => {
          if (disposed) return;
          disposed = true;
          Effect.runFork(Scope.close(scope, Exit.void));
        },
        get disposed() {
          return disposed;
        },
      };
      return store;
    }),
  );
}

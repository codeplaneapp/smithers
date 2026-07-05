import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GatewayRpcError } from "@smithers-orchestrator/gateway-client";
import { useGatewayActions } from "../useGatewayActions.ts";
import { useGatewayApprovals } from "../useGatewayApprovals.ts";
import { useGatewayRunEvents } from "../useGatewayRunEvents.ts";
import { useGatewayRunTree } from "../sync/useGatewayRunTree.ts";
import { useSmithersCollections } from "../useSmithersCollections.ts";
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
  DcPollAnswer,
  DelegationApprovalRecord,
  DelegationGraph,
  DelegationOutputRecord,
  DelegationRecord,
} from "./types.ts";

export type UseDelegationChainResult = {
  graph: DelegationGraph;
  loading: boolean;
  errors: unknown[];
  actions: {
    /** Deliver a live user edit of a node's output (Signal `dc-edit`). */
    submitEdit(logicalId: string, editedOutput: unknown, note?: string): Promise<void>;
    /** Skip the zero-backpressure preview phase (Signal `dc-skip-preview`). */
    skipPreviews(): Promise<void>;
    /** Answer a durable human request; `value` rides as JSON in `decision.note`. */
    answerHuman(nodeId: string, iteration: number, value: unknown): Promise<void>;
    /** Answer the end-of-run poll (the pending poll HumanTask). */
    submitPoll(answers: DcPollAnswer[], comment?: string): Promise<void>;
  };
};

/** Output error codes that just mean "nothing durable yet" — retry later. */
const EXPECTED_OUTPUT_ERRORS = new Set(["NodeHasNoOutput", "NodeNotFound", "IterationNotFound", "RunNotFound"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeEditId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type OutputCacheEntry =
  | { state: "produced"; record: DelegationOutputRecord }
  | { state: "missing"; finishCount: number }
  | { state: "error"; finishCount: number; error: Error };

/** Merge new fetch targets into an existing map; returns the same map when nothing is new. */
function mergeTargets(
  previous: Map<string, DelegationFetchTarget>,
  found: Map<string, DelegationFetchTarget>,
): Map<string, DelegationFetchTarget> {
  let next: Map<string, DelegationFetchTarget> | null = null;
  for (const [key, target] of found) {
    if (previous.has(key)) continue;
    (next ??= new Map(previous)).set(key, target);
  }
  return next ?? previous;
}

/** Page size for the one-shot run-event history backfill. */
const EVENT_HISTORY_PAGE_SIZE = 500;

/**
 * Folded delegation-chain state for one run, per the frozen contract.
 *
 * Record assembly: fetch targets are the union of (a) the live run tree
 * (`useGatewayRunTree`), which only reflects the CURRENT frame, and (b) the
 * durable run-event history — on mount the hook pages `listRunEvents`
 * (`afterSeq` cursor over the append-only event table) and keeps
 * accumulating node-lifecycle events from the live stream, so loop iterations
 * the tree has already replaced (exec attempt history, unmounted `dc-edit` /
 * `dc-skip-preview` listeners, budget actuals) survive reloads and late
 * joins. `getNodeOutput` fetches each (nodeId, iteration) durable row exactly
 * once (re-checked when a finish event for that node arrives), and
 * `useGatewayApprovals` supplies the `_approval` pending markers. The pure
 * `foldDelegation` reducer turns those records into the graph;
 * malformed/unknown rows surface in `errors` instead of throwing.
 */
export function useDelegationChain(params: { runId: string | undefined }): UseDelegationChainResult {
  const runId = params.runId;
  const actionsApi = useGatewayActions();
  const { client } = useSmithersCollections();
  const tree = useGatewayRunTree(runId);
  const events = useGatewayRunEvents(runId, { maxEvents: 1000 });
  const approvals = useGatewayApprovals(runId ? { filter: { runId } } : {});

  // Durable (nodeId, iteration) targets reconstructed from run events. Grows
  // monotonically per run: the live event ring is bounded, so pairs are made
  // sticky here instead of being re-derived (and lost) from the ring.
  const [eventTargets, setEventTargets] = useState<Map<string, DelegationFetchTarget>>(() => new Map());
  const [historyError, setHistoryError] = useState<Error | undefined>(undefined);

  // Targets: every delegation-relevant (nodeId, iteration) pair — current
  // tree positions unioned with the durable event-derived history.
  const targets = useMemo(() => {
    const seen = new Map<string, DelegationFetchTarget>();
    for (const node of tree.nodes) {
      if (delegationTableForNodeId(node.id) === null) continue;
      const iteration = node.iteration ?? 0;
      seen.set(`${node.id}\u0000${iteration}`, { nodeId: node.id, iteration });
    }
    for (const [key, target] of eventTargets) {
      if (!seen.has(key)) seen.set(key, target);
    }
    return seen;
  }, [tree.nodes, eventTargets]);

  // Completion ticks per node id, so missing outputs are only refetched when
  // something actually finished (not on every event frame). Durable history
  // rows carry the persisted engine type (`NodeFinished`); live wire frames
  // use `node.finished` — accept both spellings.
  const finishCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const frame of events.events) {
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
  }, [events.events]);

  const [cache, setCache] = useState<Map<string, OutputCacheEntry>>(() => new Map());
  const [hydrated, setHydrated] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());

  // Reset per run.
  useEffect(() => {
    generation.current += 1;
    inFlight.current.clear();
    setCache(new Map());
    setHydrated(false);
    setEventTargets(new Map());
    setHistoryError(undefined);
  }, [runId]);

  // Fresh-mount backfill. Mechanism choice: the gateway exposes no listNodes
  // RPC over durable node rows, but `listRunEvents` replays the full
  // append-only run-event history with `afterSeq` pagination (the same
  // surface `smithers events` uses), and every persisted node lifecycle
  // event carries `nodeId` + `iteration`. Paging it once per run
  // reconstructs ALL iterations without new RPCs and without the live event
  // ring's row bound, so it is the most robust source available.
  useEffect(() => {
    if (!runId) return;
    const current = generation.current;
    let cancelled = false;
    void (async () => {
      const found = new Map<string, DelegationFetchTarget>();
      let afterSeq: number | undefined;
      try {
        for (;;) {
          const rows = await client.api.listRunEvents({
            runId,
            limit: EVENT_HISTORY_PAGE_SIZE,
            ...(afterSeq === undefined ? {} : { afterSeq }),
          });
          if (cancelled || generation.current !== current) return;
          for (const [key, target] of delegationTargetsFromEvents(rows)) found.set(key, target);
          if (rows.length < EVENT_HISTORY_PAGE_SIZE) break;
          const lastSeq = rows[rows.length - 1]?.seq;
          // Defensive: stop rather than loop forever on a non-advancing cursor.
          if (typeof lastSeq !== "number" || (afterSeq !== undefined && lastSeq <= afterSeq)) break;
          afterSeq = lastSeq;
        }
      } catch (cause) {
        if (cancelled || generation.current !== current) return;
        setHistoryError(cause instanceof Error ? cause : new Error(String(cause)));
        // Keep whatever was collected — the tree still covers current nodes.
      }
      if (cancelled || generation.current !== current) return;
      if (found.size > 0) setEventTargets((previous) => mergeTargets(previous, found));
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, client]);

  // Live accumulation: new lifecycle events (loop advances, listener
  // deliveries) add their (nodeId, iteration) pairs as they stream in.
  useEffect(() => {
    const found = delegationTargetsFromEvents(events.events);
    if (found.size === 0) return;
    setEventTargets((previous) => mergeTargets(previous, found));
  }, [events.events]);

  useEffect(() => {
    if (!runId) {
      setHydrated(false);
      return;
    }
    const current = generation.current;
    const due: Array<{ key: string; nodeId: string; iteration: number }> = [];
    for (const [key, target] of targets) {
      const entry = cache.get(key);
      if (entry?.state === "produced") continue;
      const finishCount = finishCounts.get(target.nodeId) ?? 0;
      if (entry && entry.finishCount >= finishCount && entry.state !== "error") continue;
      if (entry?.state === "error" && entry.finishCount >= finishCount) continue;
      if (inFlight.current.has(key)) continue;
      due.push({ key, ...target });
    }
    if (due.length === 0) {
      if (!hydrated && !tree.isLoading) setHydrated(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        due.map(async ({ key, nodeId, iteration }) => {
          inFlight.current.add(key);
          const finishCount = finishCounts.get(nodeId) ?? 0;
          try {
            const response = await client.api.getNodeOutput({ runId, nodeId, iteration });
            const row = isRecord(response) && isRecord(response.row) ? response.row : undefined;
            const produced = isRecord(response) && response.status === "produced" && row !== undefined;
            const entry: OutputCacheEntry = produced
              ? {
                  state: "produced",
                  record: { table: delegationTableForNodeId(nodeId)!, nodeId, iteration, row },
                }
              : { state: "missing", finishCount };
            return { key, entry };
          } catch (cause) {
            const code = cause instanceof GatewayRpcError ? cause.code : undefined;
            if (code !== undefined && EXPECTED_OUTPUT_ERRORS.has(code)) {
              return { key, entry: { state: "missing", finishCount } as OutputCacheEntry };
            }
            const error = cause instanceof Error ? cause : new Error(String(cause));
            return { key, entry: { state: "error", finishCount, error } as OutputCacheEntry };
          } finally {
            inFlight.current.delete(key);
          }
        }),
      );
      if (cancelled || generation.current !== current) return;
      setCache((previous) => {
        const next = new Map(previous);
        for (const { key, entry } of results) next.set(key, entry);
        return next;
      });
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, targets, finishCounts, cache, hydrated, tree.isLoading, client]);

  const { graph, errors } = useMemo(() => {
    const records: DelegationRecord[] = [];
    for (const entry of cache.values()) {
      if (entry.state === "produced") records.push(entry.record);
    }
    for (const approval of runId ? approvals.data ?? [] : []) {
      if (approval.runId !== runId) continue;
      // Accept any delegation node that can carry a HumanTask/Approval: nodes
      // with an output table (question-<seq>, poll, exec, …), the listener ids
      // (dc-poll), AND the approval-only phases (`dc:<goal>:approve`,
      // `dc:<leaf>:approval-<i>`) which have no output table but must still
      // surface as awaiting-human. Non-delegation node ids stay excluded.
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
    const folded = foldDelegation(records, { onIgnored: (issue) => issues.push(issue) });
    const collected: unknown[] = [...issues];
    for (const entry of cache.values()) {
      if (entry.state === "error") collected.push(entry.error);
    }
    if (tree.error) collected.push(tree.error);
    if (events.error) collected.push(events.error);
    if (historyError) collected.push(historyError);
    return { graph: folded, errors: collected };
  }, [cache, approvals.data, runId, tree.error, events.error, historyError]);

  const requireRunId = useCallback((): string => {
    if (!runId) throw new Error("useDelegationChain: no runId.");
    return runId;
  }, [runId]);

  const answerHuman = useCallback(
    async (nodeId: string, iteration: number, value: unknown): Promise<void> => {
      await actionsApi.submitApproval({
        runId: requireRunId(),
        nodeId,
        iteration,
        decision: { approved: true, note: JSON.stringify(value) },
      });
    },
    [actionsApi, requireRunId],
  );

  const actions = useMemo<UseDelegationChainResult["actions"]>(
    () => ({
      submitEdit: async (logicalId, editedOutput, note) => {
        await actionsApi.submitSignal({
          runId: requireRunId(),
          correlationKey: "dc-edit",
          payload: { editId: makeEditId(), logicalId, editedOutput, ...(note !== undefined ? { note } : {}) },
        });
      },
      skipPreviews: async () => {
        await actionsApi.submitSignal({
          runId: requireRunId(),
          correlationKey: "dc-skip-preview",
          payload: { skipped: true },
        });
      },
      answerHuman,
      submitPoll: async (answers, comment) => {
        const pending = (approvals.data ?? []).find((approval) => {
          if (runId && approval.runId !== runId) return false;
          if (approval.nodeId === "dc-poll") return true;
          const parsed = parseDelegationNodeId(approval.nodeId);
          return parsed !== null && parsed.phase.replace(/-\d+$/, "") === "poll";
        });
        if (!pending) throw new Error("useDelegationChain: no pending poll to answer.");
        await answerHuman(pending.nodeId, pending.iteration, {
          answers,
          ...(comment !== undefined ? { comment } : {}),
        });
      },
    }),
    [actionsApi, requireRunId, answerHuman, approvals.data, runId],
  );

  return {
    graph,
    loading: Boolean(runId) && (tree.isLoading || (!hydrated && targets.size > 0)),
    errors,
    actions,
  };
}

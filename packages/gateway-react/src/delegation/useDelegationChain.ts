import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { useGatewayActions } from "../useGatewayActions.ts";
import { useGatewayApprovals } from "../useGatewayApprovals.ts";
import { useGatewayRunEvents } from "../useGatewayRunEvents.ts";
import { useGatewayRunTree } from "../sync/useGatewayRunTree.ts";
import { useSmithersCollections } from "../useSmithersCollections.ts";
import { createDelegationChainStore } from "./delegationChainStore.ts";
import { delegationTargetKey } from "./delegationEventTargets.ts";
import { delegationTableForNodeId, parseDelegationNodeId } from "./foldDelegation.ts";
import type { DcPollAnswer, DelegationGraph } from "./types.ts";

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

function makeEditId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Folded delegation-chain state for one run, per the frozen contract.
 *
 * Record assembly lives in the Effect pipeline behind
 * `createDelegationChainStore` (see `delegationChainStore.ts`): the run tree,
 * live event frames, and approvals are pushed into a Queue-fed Stream whose
 * consumer reconciles Effect-managed state (durable event-derived targets,
 * the exactly-once `getNodeOutput` cache with finish-event invalidation, the
 * paged `listRunEvents` history backfill) into a
 * `SubscriptionRef<DelegationChainSnapshot>`; this hook subscribes via
 * `useSyncExternalStore`. The pure `foldDelegation` reducer turns the
 * assembled records into the graph; malformed/unknown rows surface in
 * `errors` instead of throwing.
 */
export function useDelegationChain(params: { runId: string | undefined }): UseDelegationChainResult {
  const runId = params.runId;
  const actionsApi = useGatewayActions();
  const { client } = useSmithersCollections();
  const tree = useGatewayRunTree(runId);
  const events = useGatewayRunEvents(runId, { maxEvents: 1000 });
  const approvals = useGatewayApprovals(runId ? { filter: { runId } } : {});

  // One Effect store per (runId, client) — a run switch resets all assembly
  // state, like the old per-run generation counter. Dev/strict-mode remounts
  // dispose the store in the effect cleanup; the epoch bump recreates it when
  // the effect re-runs against an already-disposed store.
  const [storeEpoch, bumpStoreEpoch] = useReducer((epoch: number) => epoch + 1, 0);
  const store = useMemo(
    () => createDelegationChainStore({ runId, api: client.api }),
    [runId, client, storeEpoch],
  );
  useEffect(() => {
    if (store.disposed) {
      bumpStoreEpoch();
      return;
    }
    return () => store.dispose();
  }, [store]);

  // Push every input batch into the pipeline (the store dedupes internally:
  // an unchanged batch publishes no snapshot update).
  useEffect(() => {
    store.push({
      treeNodes: tree.nodes,
      treeLoading: tree.isLoading,
      events: events.events,
      approvals: approvals.data ?? [],
    });
  }, [store, tree.nodes, tree.isLoading, events.events, approvals.data]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const errors = useMemo(() => {
    const collected: unknown[] = [...snapshot.recordErrors];
    if (tree.error) collected.push(tree.error);
    if (events.error) collected.push(events.error);
    if (snapshot.historyError) collected.push(snapshot.historyError);
    return collected;
  }, [snapshot, tree.error, events.error]);

  // The tree-derived target count computed synchronously (the store's count
  // arrives a tick later), so a fresh mount with visible delegation nodes
  // reports loading from the first render — same as the pre-Effect hook.
  const treeTargetCount = useMemo(() => {
    const keys = new Set<string>();
    for (const node of tree.nodes) {
      if (delegationTableForNodeId(node.id) === null) continue;
      keys.add(delegationTargetKey(node.id, node.iteration ?? 0));
    }
    return keys.size;
  }, [tree.nodes]);
  const targetCount = Math.max(snapshot.targetCount, treeTargetCount);

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
    graph: snapshot.graph,
    loading: Boolean(runId) && (tree.isLoading || (!snapshot.hydrated && targetCount > 0)),
    errors,
    actions,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GatewayRpcError } from "@smithers-orchestrator/gateway-client";
import { useGatewayActions } from "../useGatewayActions.ts";
import { useGatewayApprovals } from "../useGatewayApprovals.ts";
import { useGatewayRunEvents } from "../useGatewayRunEvents.ts";
import { useGatewayRunTree } from "../sync/useGatewayRunTree.ts";
import { useSmithersCollections } from "../useSmithersCollections.ts";
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

/**
 * Folded delegation-chain state for one run, per the frozen contract.
 *
 * Record assembly: the live run tree (`useGatewayRunTree`) enumerates every
 * physical `dc:*` node (with loop/retry iterations), `getNodeOutput` fetches
 * each node's durable row exactly once (re-checked when a `node.finished` /
 * `node.failed` event for that node arrives — `useGatewayRunEvents` provides
 * the liveness tick), and `useGatewayApprovals` supplies the `_approval`
 * pending markers. The pure `foldDelegation` reducer turns those records into
 * the graph; malformed/unknown rows surface in `errors` instead of throwing.
 */
export function useDelegationChain(params: { runId: string | undefined }): UseDelegationChainResult {
  const runId = params.runId;
  const actionsApi = useGatewayActions();
  const { client } = useSmithersCollections();
  const tree = useGatewayRunTree(runId);
  const events = useGatewayRunEvents(runId, { maxEvents: 1000 });
  const approvals = useGatewayApprovals(runId ? { filter: { runId } } : {});

  // Targets: every delegation-relevant (nodeId, iteration) pair in the tree.
  const targets = useMemo(() => {
    const seen = new Map<string, { nodeId: string; iteration: number }>();
    for (const node of tree.nodes) {
      if (delegationTableForNodeId(node.id) === null) continue;
      const iteration = node.iteration ?? 0;
      seen.set(`${node.id}\u0000${iteration}`, { nodeId: node.id, iteration });
    }
    return seen;
  }, [tree.nodes]);

  // Completion ticks per node id, so missing outputs are only refetched when
  // something actually finished (not on every event frame).
  const finishCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const frame of events.events) {
      if (frame.event !== "node.finished" && frame.event !== "node.failed") continue;
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
  }, [runId]);

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
      if (delegationTableForNodeId(approval.nodeId) === null) continue;
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
    return { graph: folded, errors: collected };
  }, [cache, approvals.data, runId, tree.error, events.error]);

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

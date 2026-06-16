import { useEffect, useMemo, useRef, useState } from "react";
import { useSmithersGateway } from "@smithers-orchestrator/gateway-react";
import type { NodeStatus, RunNode } from "../runs/Run";
import { snapshotToRunNode } from "../gateway/snapshotToRunNode";
import { toNodeStatus } from "../gateway/toNodeStatus";

type GatewayRunTreeState = {
  root: RunNode | null;
  nodes: ReadonlyArray<RunNode>;
  status: NodeStatus;
  isLoading: boolean;
  error: Error | undefined;
};

function flattenTree(root: RunNode | null): RunNode[] {
  if (!root) return [];
  const nodes: RunNode[] = [];
  const visit = (node: RunNode): void => {
    nodes.push(node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return nodes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function statusFromRunEvent(frame: { payload?: unknown }): NodeStatus | undefined {
  const payload = asRecord(frame.payload);
  const event = asString(payload.event);
  if (!event) return undefined;
  const innerPayload = asRecord(payload.payload);
  if (event === "run.completed") {
    const state = asString(innerPayload.state) ?? asString(innerPayload.status);
    const status = toNodeStatus(state);
    if (status === "failed" || status === "ok") return status;
    return state === "failed" || state === "cancelled" ? "failed" : "ok";
  }
  if (event === "run.started" || event === "run.resumed") return "running";
  if (event === "run.paused") return "waiting";
  return undefined;
}

function withRootStatus(root: RunNode | null, status: NodeStatus): RunNode | null {
  return root ? { ...root, status } : root;
}

export function useGatewayRunTree(runId: string | undefined): GatewayRunTreeState {
  const client = useSmithersGateway();
  const generationRef = useRef(0);
  const [state, setState] = useState<GatewayRunTreeState>({
    root: null,
    nodes: [],
    status: "queued",
    isLoading: Boolean(runId),
    error: undefined,
  });

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!runId) {
      setState({
        root: null,
        nodes: [],
        status: "queued",
        isLoading: false,
        error: undefined,
      });
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    const loadSnapshot = async (loading: boolean): Promise<NodeStatus | undefined> => {
      if (loading) {
        setState((current) => ({
          ...current,
          isLoading: true,
          error: undefined,
        }));
      }
      try {
        const snapshot = await client.rpcRaw("getDevToolsSnapshot", { runId }, { signal });
        if (signal.aborted || generationRef.current !== generation) return undefined;
        const root = snapshotToRunNode(snapshot as never);
        const nodes = flattenTree(root);
        const status = root?.status ?? toNodeStatus(asString(asRecord(asRecord(snapshot).runState).state));
        setState({
          root,
          nodes,
          status,
          isLoading: false,
          error: undefined,
        });
        return status;
      } catch (cause) {
        if (signal.aborted || generationRef.current !== generation) return undefined;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((current) => ({
          ...current,
          isLoading: false,
          error,
        }));
        return undefined;
      }
    };

    const applyStatus = (status: NodeStatus): void => {
      if (signal.aborted || generationRef.current !== generation) return;
      setState((current) => {
        const root = withRootStatus(current.root, status);
        return {
          ...current,
          root,
          nodes: root ? flattenTree(root) : current.nodes,
          status,
        };
      });
    };

    void loadSnapshot(true);

    if (typeof WebSocket !== "undefined") {
      void (async () => {
        try {
          for await (const frame of client.streamDevTools({ runId }, { signal })) {
            if (signal.aborted || generationRef.current !== generation) return;
            if (frame.event === "devtools.event" || frame.event === "devtools.error") {
              await loadSnapshot(false);
            }
          }
        } catch (cause) {
          if (signal.aborted || generationRef.current !== generation) return;
          setState((current) => ({
            ...current,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          }));
        }
      })();

      void (async () => {
        try {
          for await (const frame of client.streamRunEventsResilient(
            { runId, afterSeq: 0 },
            { signal },
          )) {
            if (signal.aborted || generationRef.current !== generation) return;
            const status = statusFromRunEvent(frame);
            if (!status) continue;
            applyStatus(status);
            if (status === "ok" || status === "failed" || status === "waiting") {
              await loadSnapshot(false);
            }
          }
        } catch (cause) {
          if (signal.aborted || generationRef.current !== generation) return;
          setState((current) => ({
            ...current,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          }));
        }
      })();
    }

    return () => {
      controller.abort();
    };
  }, [client, runId]);

  return useMemo(
    () => state,
    [state],
  );
}

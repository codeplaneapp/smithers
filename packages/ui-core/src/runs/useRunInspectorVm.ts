import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGatewayNodeOutput, useGatewayRpc, useGatewayRunEvents, useGatewayRunTree } from "@smthrs/gateway-react";
import type { GatewayAsyncState, UseGatewayRunTreeResult } from "@smthrs/gateway-react";
import {
  runNodeKey,
  type GatewayEventFrame,
  type GatewayRpcPayload,
  type GatewayRunNode,
} from "@smthrs/gateway-client";
import { nodeLogEvents } from "./eventFrame.ts";
import { toNodeDiffView, type NodeDiffView } from "./diffUtils.ts";
import { defaultTab, flattenTree, resolveFocusIdx, type FlatNode, type TabId } from "./treeUtils.ts";

/**
 * The run inspector view model: tree + node detail tabs (Output/Logs/Diff/
 * Props), auto-defaulted per node kind. Built from `treeUtils.ts` (moved from
 * `packages/tui/src/modes/treeUtils.ts`) plus `useGatewayRunTree`/
 * `useGatewayNodeOutput`/`useGatewayRunEvents`/`useNodeDiff`
 * (`research/tui-parity/03-tui-screens.md` "Run inspector").
 *
 * Scope: tree navigation, tab state, and the Output/Logs/Diff/Props tab
 * content for the focused node. Approval-banner state (pending gate,
 * decision submission) stays a TreeMode-local concern for this phase — the
 * approvals view model is `research/tui-parity/01-packages.md` phase 3's
 * exemplar extraction, not phase 2's.
 */

const NODE_LOG_TAIL = 500;
export const TUI_OUTPUT_PREVIEW_CHARS = 20_000;
export const TUI_OUTPUT_TRUNCATION_MARKER = "\n... [truncated]";

function outputPreview(text: string): string {
  if (text.length <= TUI_OUTPUT_PREVIEW_CHARS) return text;
  return `${text.slice(0, TUI_OUTPUT_PREVIEW_CHARS)}${TUI_OUTPUT_TRUNCATION_MARKER}`;
}

/** Pull the human-readable output string out of an output-row object. */
function rowOutputText(row: Record<string, unknown>): string | undefined {
  if (typeof row["output"] === "string") return row["output"];
  if (typeof row["text"] === "string") return row["text"];
  if (typeof row["content"] === "string") return row["content"];
  return undefined;
}

/**
 * Derive the Output tab's text from the raw `getNodeOutput` RPC payload, which
 * is ALWAYS the envelope `{ status: produced|pending|failed, row, schema,
 * partial? }` (see the server's getNodeOutput route) — the node's actual output
 * lives at `row.output`, so the envelope must be unwrapped or the tab shows the
 * whole thing (schema descriptor included) as JSON with the real output buried
 * inside as one escaped string. Non-envelope objects keep the plain
 * string-field fallbacks for older/looser payloads.
 */
export function deriveOutputText(outputData: unknown, node: GatewayRunNode): string {
  const preview = outputPreview;
  if (outputData && typeof outputData === "object") {
    const d = outputData as Record<string, unknown>;
    const status = d["status"];
    if ("row" in d && (status === "produced" || status === "pending" || status === "failed")) {
      const row = d["row"];
      if (row && typeof row === "object") {
        const text = rowOutputText(row as Record<string, unknown>);
        return preview(text ?? JSON.stringify(row, null, 2));
      }
      if (status === "pending") return "(no output yet)";
      if (status === "failed") {
        const partial = d["partial"];
        return partial === undefined || partial === null
          ? "(failed, no output)"
          : preview(`(failed) partial output:\n${JSON.stringify(partial, null, 2)}`);
      }
      return "(no output)";
    }
    // Defensive fallback for non-envelope payloads.
    const text = rowOutputText(d);
    if (text !== undefined) return preview(text);
    return preview(JSON.stringify(d, null, 2));
  }
  if (node.output) return preview(String(node.output));
  return "(no output)";
}

/**
 * The `getNodeDiff` RPC wrapper (ported from `packages/tui/src/data.ts`
 * `useNodeDiff`). Disabled (no request issued) until both runId and nodeId
 * are known so switching focus to a node with no identity doesn't fire a bad
 * request.
 */
export function useNodeDiff(params: {
  runId: string | undefined;
  nodeId: string | undefined;
  iteration?: number;
}): GatewayAsyncState<GatewayRpcPayload<"getNodeDiff">> {
  const enabled = Boolean(params.runId && params.nodeId);
  return useGatewayRpc(
    "getNodeDiff",
    { runId: params.runId ?? "", nodeId: params.nodeId ?? "", iteration: params.iteration },
    { enabled },
  );
}

export type RunInspectorVm = {
  root: UseGatewayRunTreeResult["root"];
  nodes: UseGatewayRunTreeResult["nodes"];
  isLoading: boolean;
  error: Error | undefined;
  flat: FlatNode[];
  collapsed: ReadonlySet<string>;
  toggleCollapsed: (key: string) => void;
  focusIdx: number;
  focusRow: (idx: number) => void;
  selectedKey: string | null;
  setSelectedKey: (key: string | null) => void;
  focusedNode: GatewayRunNode | null;
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  outputText: string;
  /** The focused node's own log frames (tail-sliced), for the inspector's Logs tab. */
  nodeLogs: GatewayEventFrame[];
  diff: NodeDiffView;
  diffLoading: boolean;
  /** The RUN's full raw event stream (capped at `options.maxEvents`), for
   *  run-wide surfaces like a Graph/Logs/Timeline mode — distinct from
   *  `nodeLogs`, which is scoped to the focused node. */
  events: GatewayEventFrame[];
  streaming: boolean;
};

/**
 * Drive one run's Tree + node-inspector state: tree flatten/collapse,
 * key-anchored focus (rows insert/delete live — see `resolveFocusIdx`), tab
 * selection with an auto-default on focus change, and the focused node's
 * Output/Logs/Diff derivation. `initialSelectedNodeKey` lets a caller (e.g. a
 * Graph-mode "jump to node") hand off a starting selection. `maxEvents` caps
 * the run event stream both `nodeLogs` and the returned `events` derive from
 * (a caller sharing one cap across every consumer — e.g. packages/tui's
 * `TUI_EVENT_CAP` — keeps them all reading the same gateway collection/ring,
 * see `useGatewayRunEvents`'s doc comment); omitted, the gateway hook's own
 * default applies.
 */
export function useRunInspectorVm(
  runId: string,
  options?: { initialSelectedNodeKey?: string | null; maxEvents?: number },
): RunInspectorVm {
  const { root, nodes, isLoading, error } = useGatewayRunTree(runId);
  const { events, streaming } = useGatewayRunEvents(runId, { maxEvents: options?.maxEvents });

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("props");

  const flat = useMemo(() => flattenTree(nodes, root, collapsed), [nodes, root, collapsed]);

  const lastFocusIdxRef = useRef(0);
  const focusIdx = useMemo(() => resolveFocusIdx(flat, selectedKey, lastFocusIdxRef.current), [flat, selectedKey]);
  useEffect(() => {
    lastFocusIdxRef.current = focusIdx;
  }, [focusIdx]);

  const focusRow = useCallback(
    (idx: number) => {
      const row = flat[idx];
      if (row) setSelectedKey(runNodeKey(row.node));
    },
    [flat],
  );

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const initialSelectedNodeKey = options?.initialSelectedNodeKey;
  const focusedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialSelectedNodeKey) return;
    if (focusedSelectionRef.current === initialSelectedNodeKey) return;
    const idx = flat.findIndex((f) => runNodeKey(f.node) === initialSelectedNodeKey);
    if (idx >= 0) {
      setSelectedKey(initialSelectedNodeKey);
      focusedSelectionRef.current = initialSelectedNodeKey;
    }
  }, [initialSelectedNodeKey, flat]);

  const focusedNode = flat[focusIdx]?.node ?? null;

  useEffect(() => {
    if (focusedNode) setActiveTab(defaultTab(focusedNode));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-default only on a NEW focused node, not every re-render
  }, [focusedNode ? runNodeKey(focusedNode) : undefined]);

  const { data: outputData } = useGatewayNodeOutput({
    runId,
    nodeId: focusedNode?.id,
    iteration: focusedNode?.iteration,
  });
  const {
    data: diffData,
    loading: diffLoading,
    error: diffError,
  } = useNodeDiff({
    runId,
    nodeId: activeTab === "diff" ? focusedNode?.id : undefined,
    iteration: focusedNode?.iteration,
  });

  const nodeLogs = focusedNode
    ? nodeLogEvents(events, focusedNode.id, focusedNode.iteration).slice(-NODE_LOG_TAIL)
    : [];
  const outputText = focusedNode ? deriveOutputText(outputData, focusedNode) : "";

  return {
    root,
    nodes,
    isLoading,
    error,
    flat,
    collapsed,
    toggleCollapsed,
    focusIdx,
    focusRow,
    selectedKey,
    setSelectedKey,
    focusedNode,
    activeTab,
    setActiveTab,
    outputText,
    nodeLogs,
    diff: toNodeDiffView(diffData, diffError),
    diffLoading: activeTab === "diff" && diffLoading,
    events,
    streaming,
  };
}

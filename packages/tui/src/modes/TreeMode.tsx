import { useState, useCallback, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SyntaxStyle } from "@opentui/core";
import { useGatewayActions, useGatewayNodeOutput } from "@smithers-orchestrator/gateway-react";
import { useRunTree, useApprovals, useRunEvents } from "../data.ts";
import type { GatewayApprovalRow } from "../data.ts";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import {
  flattenTree,
  nodeGlyph,
  nodeGlyphColor,
  nodeChevron,
  defaultTab,
  ALL_TABS,
  type FlatNode,
  type TabId,
} from "./treeUtils.ts";

const TAB_KEYS: Record<string, TabId> = {
  "1": "output",
  "2": "logs",
  "3": "tools",
  "4": "diff",
  "5": "props",
};

let _syntaxStyle: SyntaxStyle | null = null;
function getPlainStyle(): SyntaxStyle {
  return (_syntaxStyle ??= SyntaxStyle.create());
}

const COMPACT_WIDTH = 100;

// ─── Approval Banner ─────────────────────────────────────────────────────────

function ApprovalBanner({
  approval,
  onApprove,
  onDeny,
}: {
  approval: GatewayApprovalRow;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <box
      width="100%"
      height={5}
      flexDirection="column"
      border={true}
      borderStyle="single"
      borderColor="#ffaf00"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="#ffaf00">{`⏸  ${approval.requestTitle ?? "Approval required"}`}</text>
      {approval.requestSummary ? (
        <text fg="#888888">{`   ${approval.requestSummary}`}</text>
      ) : null}
      <box width="100%" height={1} flexDirection="row">
        <text fg="#00d787">{"[a] approve"}</text>
        <text fg="#555555">{"   "}</text>
        <text fg="#ff5f5f">{"[d] deny"}</text>
      </box>
    </box>
  );
}

// ─── Tab Bar ─────────────────────────────────────────────────────────────────

function TabBar({ activeTab }: { activeTab: TabId }) {
  return (
    <box width="100%" height={1} flexDirection="row">
      {ALL_TABS.map((t) => (
        <text key={t} fg={t === activeTab ? "#ffffff" : "#555555"} bg={t === activeTab ? "#333333" : undefined}>
          {` ${t} `}
        </text>
      ))}
    </box>
  );
}

// ─── Node Inspector ───────────────────────────────────────────────────────────

function NodeInspector({
  runId,
  node,
  approval,
  activeTab,
  onApprove,
  onDeny,
}: {
  runId: string;
  node: GatewayRunNode | null;
  approval: GatewayApprovalRow | undefined;
  activeTab: TabId;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { events } = useRunEvents(runId);
  const { data: outputData } = useGatewayNodeOutput({ runId, nodeId: node?.id });

  if (!node) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        <text fg="#444444">{"  Select a node from the tree (j/k to move)"}</text>
      </box>
    );
  }

  const nodeLogs = events
    .filter((e) => {
      const p = e.payload as Record<string, unknown> | null;
      return p != null && (p["nodeId"] === node.id || p["node_id"] === node.id);
    })
    .slice(-500);

  const outputText: string = (() => {
    if (outputData && typeof outputData === "object") {
      const d = outputData as Record<string, unknown>;
      if (typeof d["output"] === "string") return d["output"];
      if (typeof d["text"] === "string") return d["text"];
      if (typeof d["content"] === "string") return d["content"];
      return JSON.stringify(d, null, 2);
    }
    if (node.output) return String(node.output);
    return "(no output)";
  })();

  const propsText = JSON.stringify(
    {
      id: node.id,
      name: node.name,
      kind: node.kind,
      status: node.status,
      agent: node.agent,
      meta: node.meta,
      cardLabel: node.cardLabel,
      parentId: node.parentId,
      childIds: node.childIds,
    },
    null,
    2,
  );

  const toolCallsText =
    (node.toolCalls?.length ?? 0) > 0
      ? JSON.stringify(node.toolCalls, null, 2)
      : "(no tool calls)";

  const style = getPlainStyle();

  return (
    <box width="100%" height="100%" flexDirection="column">
      {approval ? (
        <ApprovalBanner approval={approval} onApprove={onApprove} onDeny={onDeny} />
      ) : null}
      <TabBar activeTab={activeTab} />
      <box width="100%" flexGrow={1}>
        {activeTab === "output" && (
          <scrollbox width="100%" height="100%" stickyScroll scrollY>
            <code width="100%" content={outputText} syntaxStyle={style} wrapMode="char" />
          </scrollbox>
        )}
        {activeTab === "logs" && (
          <scrollbox width="100%" height="100%" stickyScroll stickyStart="bottom" scrollY>
            {nodeLogs.length === 0 ? (
              <text fg="#444444">{"  (no log events for this node)"}</text>
            ) : (
              nodeLogs.map((e, i) => (
                <text key={i} fg="#888888" wrapMode="char">
                  {`  [${e.seq}] ${e.event}  ${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`}
                </text>
              ))
            )}
          </scrollbox>
        )}
        {activeTab === "tools" && (
          <scrollbox width="100%" height="100%" scrollY>
            <code width="100%" content={toolCallsText} syntaxStyle={style} filetype="json" wrapMode="char" />
          </scrollbox>
        )}
        {activeTab === "diff" && (
          <scrollbox width="100%" height="100%" scrollY>
            <diff width="100%" height="100%" />
          </scrollbox>
        )}
        {activeTab === "props" && (
          <scrollbox width="100%" height="100%" scrollY>
            <code width="100%" content={propsText} syntaxStyle={style} filetype="json" wrapMode="char" />
          </scrollbox>
        )}
      </box>
    </box>
  );
}

// ─── Tree Panel ───────────────────────────────────────────────────────────────

function TreePanel({
  flat,
  focusIdx,
  panelWidth,
}: {
  flat: FlatNode[];
  focusIdx: number;
  panelWidth: number;
}) {
  if (flat.length === 0) {
    return (
      <scrollbox width="100%" height="100%">
        <text fg="#444444">{"  (no nodes)"}</text>
      </scrollbox>
    );
  }

  return (
    <scrollbox width="100%" height="100%" scrollY>
      {flat.map(({ node, depth, hasChildren, isCollapsed }, i) => {
        const isFocused = i === focusIdx;
        const chevron = nodeChevron(hasChildren, isCollapsed);
        const glyph = nodeGlyph(node.status ?? "");
        const glyphColor = nodeGlyphColor(node.status ?? "");
        const label = node.cardLabel ?? node.name ?? node.id;
        const meta = node.meta ? ` ${node.meta}` : "";
        const indentWidth = depth * 2;
        const reservedWidth = indentWidth + 4 + meta.length;
        const maxLabelWidth = Math.max(8, panelWidth - reservedWidth);
        const truncLabel =
          label.length > maxLabelWidth ? label.slice(0, maxLabelWidth - 1) + "…" : label;

        return (
          <box
            key={node.id}
            width="100%"
            height={1}
            flexDirection="row"
            backgroundColor={isFocused ? "#1a1a2e" : undefined}
          >
            <text fg="#333333">{" ".repeat(indentWidth)}</text>
            <text fg="#555555">{chevron}</text>
            <text fg={glyphColor}>{` ${glyph} `}</text>
            <text fg={isFocused ? "#ffffff" : "#cccccc"}>{truncLabel}</text>
            {meta ? <text fg="#555555">{meta}</text> : null}
          </box>
        );
      })}
    </scrollbox>
  );
}

// ─── Main TreeMode ────────────────────────────────────────────────────────────

export function TreeMode({
  runId,
  initialSelectedNodeId,
}: {
  runId: string;
  initialSelectedNodeId?: string | null;
}) {
  const { root, nodes, isLoading, error } = useRunTree(runId);
  const { data: approvalsData } = useApprovals(runId);
  const actions = useGatewayActions();
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);

  // When switching from Graph mode with a selected node, scroll to it
  useEffect(() => {
    if (!initialSelectedNodeId || nodes.length === 0) return;
    const flat = flattenTree(nodes, root, collapsed);
    const idx = flat.findIndex((f) => f.node.id === initialSelectedNodeId);
    if (idx >= 0) setFocusIdx(idx);
  }, [initialSelectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [focusPane, setFocusPane] = useState<"tree" | "inspector">("tree");
  const [activeTab, setActiveTab] = useState<TabId>("props");

  const flat = flattenTree(nodes, root, collapsed);
  const safeIdx = flat.length > 0 ? Math.min(focusIdx, flat.length - 1) : 0;
  const focusedNode = flat[safeIdx]?.node ?? null;

  useEffect(() => {
    if (focusedNode) setActiveTab(defaultTab(focusedNode));
  }, [focusedNode?.id]);

  const approvals = approvalsData ?? [];
  const nodeApproval = focusedNode
    ? approvals.find((a) => a.nodeId === focusedNode.id)
    : undefined;

  const handleApprove = useCallback(() => {
    if (!nodeApproval) return;
    void actions.submitApproval({
      runId,
      nodeId: nodeApproval.nodeId,
      iteration: nodeApproval.iteration,
      decision: { approved: true },
    });
  }, [nodeApproval, runId, actions]);

  const handleDeny = useCallback(() => {
    if (!nodeApproval) return;
    void actions.submitApproval({
      runId,
      nodeId: nodeApproval.nodeId,
      iteration: nodeApproval.iteration,
      decision: { approved: false },
    });
  }, [nodeApproval, runId, actions]);

  useKeyboard((e) => {
    const key = e.name;

    if (key === "tab") {
      setFocusPane((p) => (p === "tree" ? "inspector" : "tree"));
      return;
    }
    if (key === "escape") {
      setFocusPane("tree");
      return;
    }

    // 1-5 switch NodeInspector tabs from anywhere in TREE mode
    if (key in TAB_KEYS) {
      setActiveTab(TAB_KEYS[key]!);
      return;
    }

    if (focusPane === "inspector") {
      if (key === "left") {
        setActiveTab((prev) => {
          const idx = ALL_TABS.indexOf(prev);
          return ALL_TABS[Math.max(0, idx - 1)] ?? prev;
        });
      } else if (key === "right") {
        setActiveTab((prev) => {
          const idx = ALL_TABS.indexOf(prev);
          return ALL_TABS[Math.min(ALL_TABS.length - 1, idx + 1)] ?? prev;
        });
      }
      return;
    }

    if (focusPane === "tree") {
      if (key === "j" || key === "down") {
        setFocusIdx((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
      } else if (key === "k" || key === "up") {
        setFocusIdx((i) => Math.max(i - 1, 0));
      } else if (key === "space") {
        const item = flat[safeIdx];
        if (item?.hasChildren) {
          const id = item.node.id;
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }
      } else if (key === "return") {
        if (flat.length > 0) setFocusPane("inspector");
      } else if (key === "a" && nodeApproval) {
        handleApprove();
      } else if (key === "d" && nodeApproval) {
        handleDeny();
      }
    }
  });

  if (isLoading) {
    return (
      <box width="100%" height="100%">
        <text fg="#555555">{"  Loading run tree…"}</text>
      </box>
    );
  }

  if (error) {
    return (
      <box width="100%" height="100%">
        <text fg="#ff5f5f">{`  Error: ${error.message}`}</text>
      </box>
    );
  }

  const treePanelWidth = Math.floor(width * 0.38);

  if (compact) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        <box width="100%" height="50%">
          <TreePanel flat={flat} focusIdx={safeIdx} panelWidth={Math.floor(width * 0.5)} />
        </box>
        <box width="100%" flexGrow={1}>
          <NodeInspector
            runId={runId}
            node={focusedNode}
            approval={nodeApproval}
            activeTab={activeTab}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        </box>
      </box>
    );
  }

  return (
    <box width="100%" height="100%" flexDirection="row">
      <box width="38%" height="100%" border={["right"]} borderColor="#333333">
        <TreePanel flat={flat} focusIdx={safeIdx} panelWidth={treePanelWidth} />
      </box>
      <box width="62%" height="100%">
        <NodeInspector
          runId={runId}
          node={focusedNode}
          approval={nodeApproval}
          activeTab={activeTab}
          onApprove={handleApprove}
          onDeny={handleDeny}
        />
      </box>
    </box>
  );
}

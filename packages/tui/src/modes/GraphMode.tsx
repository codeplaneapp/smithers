import { useState, useMemo, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRunTree } from "../data.ts";
import { useOverlayOpen } from "../OverlayContext.tsx";
import { nodeGlyph, nodeGlyphColor, isModifiedKeyEvent } from "./treeUtils.ts";
import { computeGraphLayout, connectorArrow, edgesForConnector, hasIncomingEdge } from "./graphUtils.ts";
import { runNodeKey, type GatewayRunNode } from "@smithers-orchestrator/gateway-client";

const CARD_H = 3; // top border + 1 content row + bottom border
const ROW_GAP = 1; // vertical space between cards in a column
const CARD_SLOT = CARD_H + ROW_GAP;
const COMPACT_WIDTH = 100;
const CARD_W_NORMAL = 20;
const CARD_W_COMPACT = 14;

// ─── NodeCard ────────────────────────────────────────────────────────────────

function NodeCard({ node, isSelected, cardWidth }: { node: GatewayRunNode; isSelected: boolean; cardWidth: number }) {
  const color = nodeGlyphColor(node.status ?? "");
  const glyph = nodeGlyph(node.status ?? "");
  const label = node.cardLabel ?? node.name ?? node.id;
  const maxLabelLen = Math.max(1, cardWidth - 5); // 2 border + glyph + space + padding
  const truncLabel = label.length > maxLabelLen ? label.slice(0, maxLabelLen - 1) + "…" : label;

  return (
    <box
      width={cardWidth}
      height={CARD_H}
      border={true}
      borderStyle="single"
      borderColor={isSelected ? "#ffffff" : color}
      backgroundColor={isSelected ? "#1a1a2e" : undefined}
      flexDirection="row"
      paddingLeft={1}
    >
      <text fg={color}>{glyph}</text>
      <text fg={isSelected ? "#ffffff" : "#cccccc"}>{` ${truncLabel}`}</text>
    </box>
  );
}

// ─── ConnectorColumn ──────────────────────────────────────────────────────────
//
// A narrow column between two data columns that renders arrow characters.
// For each slot (row position) in the right column that has an incoming
// edge, we show an arrow on the card-content row (index 1 of the CARD_SLOT).

function ConnectorColumn({
  numSlots,
  connEdges,
  compact,
}: {
  numSlots: number;
  connEdges: Array<{ fromRow: number; toRow: number }>;
  compact: boolean;
}) {
  const arrow = connectorArrow(compact);
  // Cell width is derived from the arrow so the glyph can never overflow its
  // column (see #582); a blank slot fills the same width with spaces.
  const arrowWidth = arrow.length;
  const blank = " ".repeat(arrowWidth);

  const slots = Array.from({ length: numSlots }, (_, toRow) => hasIncomingEdge(connEdges, toRow));

  return (
    <box flexDirection="column" flexShrink={0} width={arrowWidth}>
      {slots.map((hasEdge, slotIdx) => (
        <box key={slotIdx} flexDirection="column" flexShrink={0} width={arrowWidth}>
          {/* top border row of the card */}
          <box height={1} width={arrowWidth} />
          {/* content row: arrow or blank */}
          <text fg="#555555">{hasEdge ? arrow : blank}</text>
          {/* bottom border row of the card */}
          <box height={1} width={arrowWidth} />
          {/* row gap (skip after last slot) */}
          {slotIdx < slots.length - 1 ? <box height={ROW_GAP} width={arrowWidth} /> : null}
        </box>
      ))}
    </box>
  );
}

// ─── GraphMode ────────────────────────────────────────────────────────────────

export function GraphMode({ runId, onSelectNodeKey }: { runId: string; onSelectNodeKey?: (nodeKey: string) => void }) {
  const { nodes, root, isLoading, error } = useRunTree(runId);
  return <GraphView nodes={nodes} root={root} isLoading={isLoading} error={error} onSelectNodeKey={onSelectNodeKey} />;
}

/**
 * Presentational graph view: the DAG layout + keyboard navigation over injected
 * tree data. `GraphMode` is a thin wrapper that only reads `useRunTree` and
 * forwards it here, so render tests can exercise the real view (cards, connector
 * arrows, Enter→onSelectNodeKey) without a live gateway.
 */
export function GraphView({
  nodes,
  root,
  isLoading,
  error,
  onSelectNodeKey,
}: Pick<ReturnType<typeof useRunTree>, "nodes" | "root" | "isLoading" | "error"> & {
  onSelectNodeKey?: (nodeKey: string) => void;
}) {
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;
  const cardWidth = compact ? CARD_W_COMPACT : CARD_W_NORMAL;

  const layout = useMemo(() => computeGraphLayout(nodes, root), [nodes, root]);

  // Flat navigation order: column-major (all of col 0, then col 1, ...)
  const flatNodeKeys = useMemo(() => layout.colGroups.flatMap((g) => g), [layout.colGroups]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const safeIdx = flatNodeKeys.length > 0 ? Math.min(selectedIdx, flatNodeKeys.length - 1) : 0;
  const selectedNodeKey = flatNodeKeys[safeIdx] ?? null;
  const overlayOpen = useOverlayOpen();

  useKeyboard((e) => {
    // Keys must not leak through an open help overlay, and ctrl/meta chords
    // are not graph bindings.
    if (overlayOpen || isModifiedKeyEvent(e)) return;
    const key = e.name;
    if (key === "j" || key === "down") {
      setSelectedIdx((i) => Math.min(i + 1, Math.max(0, flatNodeKeys.length - 1)));
    } else if (key === "k" || key === "up") {
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (key === "return" && selectedNodeKey) {
      onSelectNodeKey?.(selectedNodeKey);
    }
  });

  if (isLoading) {
    return (
      <box width="100%" height="100%">
        <text fg="#555555">{"  Loading graph…"}</text>
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

  if (nodes.length === 0) {
    return (
      <box width="100%" height="100%">
        <text fg="#444444">{"  (no nodes)"}</text>
      </box>
    );
  }

  // Graph layout (colGroups/positions/edges) is keyed by the unique row `key`,
  // so the lookup and the selection identity must use `key` too.
  const nodeMap = new Map(nodes.map((n) => [runNodeKey(n), n]));
  const { positions, colGroups, edges, numCols } = layout;

  // Build the column elements interleaved with connector elements
  const elements: ReactNode[] = [];

  for (let c = 0; c < numCols; c++) {
    const colIds = colGroups[c] ?? [];
    const numSlots = layout.maxRows;

    // Data column
    elements.push(
      <box key={`col-${c}`} flexDirection="column" flexShrink={0}>
        {Array.from({ length: numSlots }, (_, slotIdx) => {
          const nodeKey = colIds[slotIdx];
          const node = nodeKey ? nodeMap.get(nodeKey) : undefined;

          if (!node) {
            // Empty slot — preserve vertical alignment
            return <box key={slotIdx} height={slotIdx < numSlots - 1 ? CARD_SLOT : CARD_H} width={cardWidth} />;
          }

          return (
            <box key={nodeKey} flexDirection="column" flexShrink={0}>
              <NodeCard node={node} isSelected={nodeKey === selectedNodeKey} cardWidth={cardWidth} />
              {slotIdx < numSlots - 1 ? <box height={ROW_GAP} width={cardWidth} /> : null}
            </box>
          );
        })}
      </box>,
    );

    // Connector column between this column and the next
    if (c < numCols - 1) {
      const connEdges = edgesForConnector(edges, positions, c);
      elements.push(<ConnectorColumn key={`conn-${c}`} numSlots={numSlots} connEdges={connEdges} compact={compact} />);
    }
  }

  const hint = compact ? `[g]tree [j/k]nav [⏎]inspect` : `[g] toggle tree/graph   [j/k] navigate   [⏎] inspect node`;

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1}>
        <text fg="#555555">{`  GRAPH — ${nodes.length} node(s)   ${hint}`}</text>
      </box>
      <scrollbox width="100%" flexGrow={1} scrollY scrollX>
        <box flexDirection="row">{elements}</box>
      </scrollbox>
    </box>
  );
}

/** @jsxImportSource react */
import { useInsertionEffect, type CSSProperties, type ReactNode } from "react";
import { useGatewayRunTree } from "@smthrs/gateway-react";
import { EmptyState, StatusPill, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui";
import { nodeStatusIndex, rollupNodeStatus } from "./runNodeStatus";
import { ensureGatewayUiStyles, theme } from "./theme";

export type FleetTableItem = {
  /** Stable row key, usually the fleet item id. */
  key: string;
  /** First column content. */
  title: ReactNode;
  /** Extra dim cells rendered between title and status (one per `columns` entry). */
  meta?: ReadonlyArray<ReactNode>;
  /**
   * The nodes making up this item's pipeline (e.g. `["x:implement",
   * "x:review"]`). With `runId` set, the row's status is rolled up live from
   * the run tree (see `rollupNodeStatus`).
   */
  nodeIds?: readonly string[];
  /** Explicit status override; wins over the `nodeIds` rollup. */
  status?: string;
};

export type FleetTableProps = {
  /** The run whose node statuses drive per-item rollups (optional for static tables). */
  runId?: string;
  items: ReadonlyArray<FleetTableItem>;
  /** Header label for the title column (default "item"). */
  titleColumn?: ReactNode;
  /** Header labels for the `meta` columns, in order. */
  columns?: ReadonlyArray<ReactNode>;
  /** Header label for the trailing status column (default "status"). */
  statusColumn?: ReactNode;
  /** The selected row's key; selection highlights the row. */
  selectedKey?: string;
  /** Row click/keyboard handler. Rows are focusable when provided. */
  onSelect?: (key: string) => void;
  className?: string;
  style?: CSSProperties;
  /**
   * Test seam: the run-tree hook to read from. Defaults to
   * {@link useGatewayRunTree}.
   * @internal
   */
  useRunTree?: typeof useGatewayRunTree;
};

/**
 * Selectable fleet/ledger table with live per-item status — the standard left
 * pane of a fan-out workflow dashboard. Each row is one work item; give it the
 * item's pipeline `nodeIds` and the status pill tracks the run tree
 * (`queued → running → ok/failed`) without any hand-rolled status derivation.
 * Pair with a detail pane (NodeChatStream + NodeOutputCard) keyed off
 * `selectedKey`.
 *
 * @example
 * <FleetTable
 *   runId={runId}
 *   columns={["phase"]}
 *   items={ledger.map((v) => ({
 *     key: v.id,
 *     title: v.title,
 *     meta: [v.phase],
 *     nodeIds: [`${v.id}:implement`, `${v.id}:review`, `${v.id}:commit`],
 *   }))}
 *   selectedKey={selected}
 *   onSelect={setSelected}
 * />
 */
export function FleetTable({
  runId,
  items,
  titleColumn = "item",
  columns = [],
  statusColumn = "status",
  selectedKey,
  onSelect,
  className,
  style,
  useRunTree = useGatewayRunTree,
}: FleetTableProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const tree = useRunTree(runId);
  const statuses = nodeStatusIndex(tree.nodes);
  // While the run tree is still loading, rolled-up statuses would all read
  // "queued" — a lie. Gate the pills on the tree's readiness instead.
  const treeLoading = Boolean(runId) && tree.isLoading;
  return (
    <Table className={className} style={style} role="grid">
      <TableHeader>
        <TableRow role="row">
          <TableHead role="columnheader">{titleColumn}</TableHead>
          {columns.map((column, index) => (
            <TableHead key={index} role="columnheader">
              {column}
            </TableHead>
          ))}
          <TableHead role="columnheader">{statusColumn}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow role="row">
            <TableCell role="gridcell" colSpan={columns.length + 2}>
              <EmptyState description="No items." />
            </TableCell>
          </TableRow>
        ) : null}
        {items.map((item) => {
          const status =
            item.status ??
            (treeLoading ? undefined : item.nodeIds ? rollupNodeStatus(statuses, item.nodeIds) : "pending");
          const selected = selectedKey === item.key;
          return (
            <TableRow
              key={item.key}
              role="row"
              className="gw-fleet-row"
              aria-selected={onSelect ? selected : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onClick={onSelect ? () => onSelect(item.key) : undefined}
              onKeyDown={
                onSelect
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(item.key);
                      }
                    }
                  : undefined
              }
              style={{
                cursor: onSelect ? "pointer" : undefined,
                background: selected ? theme.accentSoft : undefined,
                boxShadow: selected ? `inset 2px 0 0 ${theme.accent}` : undefined,
              }}
            >
              <TableCell role="gridcell">{item.title}</TableCell>
              {columns.map((_, index) => (
                <TableCell key={index} role="gridcell" style={{ color: theme.textDim }}>
                  {item.meta?.[index] ?? null}
                </TableCell>
              ))}
              <TableCell role="gridcell">
                {status === undefined ? (
                  <span style={{ color: theme.textDim, fontSize: 12 }}>Loading…</span>
                ) : (
                  <StatusPill status={status} />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

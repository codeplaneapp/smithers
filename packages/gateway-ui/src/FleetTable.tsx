/** @jsxImportSource react */
import type { CSSProperties, ReactNode } from "react";
import { useGatewayRunTree } from "@smithers-orchestrator/gateway-react";
import { StatusPill, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smithers-orchestrator/ui";
import { nodeStatusIndex, rollupNodeStatus } from "./runNodeStatus";
import { theme } from "./theme";

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
  const tree = useRunTree(runId);
  const statuses = nodeStatusIndex(tree.nodes);
  return (
    <Table className={className} style={style}>
      <TableHeader>
        <TableRow>
          <TableHead>{titleColumn}</TableHead>
          {columns.map((column, index) => (
            <TableHead key={index}>{column}</TableHead>
          ))}
          <TableHead>{statusColumn}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const status = item.status ?? (item.nodeIds ? rollupNodeStatus(statuses, item.nodeIds) : "pending");
          const selected = selectedKey === item.key;
          return (
            <TableRow
              key={item.key}
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
              <TableCell>{item.title}</TableCell>
              {columns.map((_, index) => (
                <TableCell key={index} style={{ color: theme.textDim }}>
                  {item.meta?.[index] ?? null}
                </TableCell>
              ))}
              <TableCell>
                <StatusPill status={status} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

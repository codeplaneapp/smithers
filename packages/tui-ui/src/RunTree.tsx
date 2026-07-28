/** @jsxImportSource @opentui/react */
import { StatusGlyph } from "./StatusGlyph.tsx";

/**
 * One already-windowed tree row (see ui-core's `treeScrollWindow`/
 * `flattenTree`): the caller flattens the gateway node tree, resolves focus,
 * and slices the visible window BEFORE handing rows here — this leaf only
 * renders what it is given, no business logic.
 */
export type RunTreeRow = {
  key: string;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  status: string;
  label: string;
  meta?: string;
};

/** The row's fold indicator. Pure so it is testable without a TTY. */
export function runTreeChevron(hasChildren: boolean, isCollapsed: boolean): string {
  if (!hasChildren) return "·";
  return isCollapsed ? "▸" : "▾";
}

/** Truncate a row label to fit the reserved width, mirroring TreeMode's TreePanel. */
export function truncateRunTreeLabel(label: string, maxWidth: number): string {
  return label.length > maxWidth ? `${label.slice(0, maxWidth - 1)}…` : label;
}

export type RunTreeProps = {
  rows: readonly RunTreeRow[];
  /** The `key` of the focused row, if any is visible in this window. */
  focusedKey?: string | null;
  /** Pane width in columns, for label truncation (mirrors TreeMode's TreePanel). */
  panelWidth: number;
};

/**
 * The run inspector's tree pane: rows + chevrons + status glyphs. Moved out of
 * `packages/tui/src/modes/TreeMode.tsx`'s `TreePanel` so it is a reusable
 * tui-ui leaf (research/tui-parity/01-packages.md "packages/tui-ui" phase 2).
 * Props-in/callbacks-out: no gateway data, no keyboard handling, no scroll
 * windowing (that stays a `useRunInspectorVm` + ui-core `treeScrollWindow`
 * concern in the caller).
 */
export function RunTree({ rows, focusedKey, panelWidth }: RunTreeProps) {
  if (rows.length === 0) {
    return (
      <box width="100%" height="100%">
        <text fg="#444444">{"  (no nodes)"}</text>
      </box>
    );
  }

  return (
    <box width="100%" height="100%" flexDirection="column">
      {rows.map((row) => {
        const isFocused = row.key === focusedKey;
        const meta = row.meta ? ` ${row.meta}` : "";
        const indentWidth = row.depth * 2;
        const reservedWidth = indentWidth + 4 + meta.length;
        const maxLabelWidth = Math.max(8, panelWidth - reservedWidth);
        const truncLabel = truncateRunTreeLabel(row.label, maxLabelWidth);

        return (
          <box
            key={row.key}
            width="100%"
            height={1}
            flexDirection="row"
            backgroundColor={isFocused ? "#1a1a2e" : undefined}
          >
            <text fg="#333333">{" ".repeat(indentWidth)}</text>
            <text fg="#555555">{runTreeChevron(row.hasChildren, row.isCollapsed)}</text>
            <text> </text>
            <StatusGlyph status={row.status} />
            <text> </text>
            <text fg={isFocused ? "#ffffff" : "#cccccc"}>{truncLabel}</text>
            {meta ? <text fg="#555555">{meta}</text> : null}
          </box>
        );
      })}
    </box>
  );
}

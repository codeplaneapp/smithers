/** @jsxImportSource @opentui/react */
import { sanitizeTerminalText } from "./sanitizeTerminalText.ts";

/**
 * One already-normalized log row: the caller unwraps the gateway's event
 * envelope (ui-core's `normalizeFrame`/`unwrapEvent`) before handing rows
 * here — this leaf only formats and renders, no envelope-shape knowledge.
 */
export type RunEventLogRow = {
  seq: number;
  event: string;
  payload: string;
};

export function formatRunEventLogRow(row: RunEventLogRow): string {
  return `  [${row.seq}] ${sanitizeTerminalText(row.event)}  ${sanitizeTerminalText(row.payload)}`;
}

export type RunEventLogProps = {
  rows: readonly RunEventLogRow[];
  emptyLabel?: string;
};

/**
 * A node/run event log: a scrollbox of formatted rows, moved out of
 * `packages/tui/src/modes/TreeMode.tsx`'s Logs tab so it is a reusable
 * tui-ui leaf shared with LogMode (research/tui-parity/01-packages.md
 * "packages/tui-ui" phase 2). Props-in/callbacks-out.
 */
export function RunEventLog({ rows, emptyLabel = "(no log events)" }: RunEventLogProps) {
  if (rows.length === 0) {
    return (
      <box width="100%" height="100%">
        <text fg="#444444">{`  ${sanitizeTerminalText(emptyLabel)}`}</text>
      </box>
    );
  }

  return (
    <scrollbox width="100%" height="100%" stickyScroll stickyStart="bottom" scrollY>
      {rows.map((row, i) => (
        <text key={i} fg="#888888" wrapMode="char">
          {formatRunEventLogRow(row)}
        </text>
      ))}
    </scrollbox>
  );
}

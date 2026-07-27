/** @jsxImportSource @opentui/react */

export type KeybarEntry = {
  key: string;
  label: string;
};

/**
 * Format keybar entries as `[key] label` joined by separators, mirroring
 * packages/tui's `App.tsx` Keybar row. Pure so the formatting is testable
 * without a TTY.
 */
export function formatKeybarEntries(entries: readonly KeybarEntry[], compact = false): string {
  const sep = compact ? " " : "   ";
  const fmt = (entry: KeybarEntry) => (compact ? `[${entry.key}]${entry.label}` : `[${entry.key}] ${entry.label}`);
  return entries.map(fmt).join(sep);
}

export type KeybarProps = {
  entries: readonly KeybarEntry[];
  compact?: boolean;
};

/** A single-row keybinding legend. Props-in/callbacks-out: no keyboard handling. */
export function Keybar({ entries, compact = false }: KeybarProps) {
  return (
    <box width="100%" height={1}>
      <text fg="#888888">{formatKeybarEntries(entries, compact)}</text>
    </box>
  );
}

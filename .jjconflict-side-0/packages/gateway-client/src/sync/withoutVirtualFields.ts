// Normalize a row for comparison by dropping virtual ($-prefixed) fields and
// undefined values. reconcileSnapshotNodes runs the PREVIOUS row through this
// before deepEquals so virtual fields and explicit undefineds don't produce
// spurious update writes.
export function withoutVirtualFields<TRow extends object>(row: TRow): TRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("$") && value !== undefined) {
      out[key] = value;
    }
  }
  return out as TRow;
}

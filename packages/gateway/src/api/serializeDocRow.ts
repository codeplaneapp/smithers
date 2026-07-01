export function serializeDocRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

export function serializeRunEventRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

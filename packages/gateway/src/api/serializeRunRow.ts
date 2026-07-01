export function serializeRunRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

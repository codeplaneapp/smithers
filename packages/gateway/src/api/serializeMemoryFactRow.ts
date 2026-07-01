export function serializeMemoryFactRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

export function serializeCronRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

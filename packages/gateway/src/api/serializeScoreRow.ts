export function serializeScoreRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

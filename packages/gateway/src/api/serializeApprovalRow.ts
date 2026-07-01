export function serializeApprovalRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

export function serializeTicketRow<Row extends Record<string, unknown>>(row: Row): Row {
  return { ...row };
}

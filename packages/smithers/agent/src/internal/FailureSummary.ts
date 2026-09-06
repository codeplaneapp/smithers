/** The innermost typed sentence from the engine's JSON-safe failure value. */
export const failureSummary = (failure: unknown): string | undefined => {
  let current = failure
  let summary: string | undefined
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
    const row = current as Record<string, unknown>
    if (typeof row["message"] === "string" && row["message"].trim() !== "") {
      const code = typeof row["code"] === "string" && row["code"] !== "" ? `${row["code"].slice(0, 128)}: ` : ""
      summary = `${code}${row["message"].replace(/\s+/g, " ").trim().slice(0, 1024)}`
    }
    current = row["cause"]
  }
  return summary
}

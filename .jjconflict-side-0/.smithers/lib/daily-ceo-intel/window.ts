import type { WindowOutput } from "./schemas";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const ET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

export function issueDateForEt(windowEndIso: string): string {
  return ET_DATE_FORMATTER.format(new Date(windowEndIso));
}

export function computeWindow(windowEndOverride: string | null, runStartIso: string): WindowOutput {
  const overridden = windowEndOverride !== null;
  const windowEnd = windowEndOverride ?? runStartIso;
  if (Number.isNaN(Date.parse(windowEnd))) throw new Error(`windowEnd is not a valid ISO-8601 timestamp: ${windowEnd}`);
  const windowStart = new Date(Date.parse(windowEnd) - WINDOW_MS).toISOString();
  const issueDateEt = issueDateForEt(windowEnd);
  return {
    windowStart,
    windowEnd: new Date(windowEnd).toISOString(),
    issueDateEt,
    overridden,
    summary: `Window ${windowStart} .. ${windowEnd} (issue date ${issueDateEt} ET)${overridden ? ", overridden" : ""}.`,
  };
}

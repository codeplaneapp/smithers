import { isNotableEvent } from "./monitorModel.ts";

const typeOf = (event: any) => String(event?.type ?? event?.event ?? "");
const seqOf = (event: any) => Number(event?.seq ?? event?.sequence ?? event?.eventSeq ?? -1);

export function latestSeqOf(events: unknown): number {
  return Array.isArray(events) ? events.reduce((latest, event) => Math.max(latest, Number.isFinite(seqOf(event)) ? seqOf(event) : -1), -1) : -1;
}
export function latestNotableSeqOf(events: unknown): number {
  return latestSeqOf(Array.isArray(events) ? events.filter((event) => isNotableEvent(typeOf(event))) : events);
}
export function shouldRefreshRecap({ lastToSeq, latestNotableSeq, lastFetchedAtMs, lastAttemptAtMs, consecutiveFailures = 0, nowMs, live, inFlight }: { lastToSeq?: number; latestNotableSeq: number; lastFetchedAtMs?: number; lastAttemptAtMs?: number; consecutiveFailures?: number; nowMs: number; live: boolean; inFlight: boolean }): boolean {
  if (inFlight) return false;
  // A failed fetch leaves lastToSeq stale, so the growth trigger below would
  // re-fire on every render; hold retries behind a doubling, capped backoff.
  if (consecutiveFailures > 0 && nowMs - (lastAttemptAtMs ?? 0) < Math.min(15_000 * 2 ** (consecutiveFailures - 1), 180_000)) return false;
  if (latestNotableSeq > (lastToSeq ?? -1)) return true;
  return live && nowMs - (lastFetchedAtMs ?? 0) >= 180_000;
}
export function formatRecapAge(generatedAtMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - generatedAtMs) / 1000));
  return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// Recap summary parsing: narrated recaps arrive as an "Outcome:" sentence
// followed by "- Label: value" bullet lines. The lede is the sentence; empty
// bullets ("None recorded.") fold into one dim fact line instead of a wall of
// filler; anything unparseable renders exactly as written.
// ---------------------------------------------------------------------------

export type RecapView = {
  lede: string;
  /** Bullet lines with real content, rendered one per line under the lede. */
  notable: Array<{ label: string; value: string }>;
  /** One dim line folding the zero-facts, or null when there are none. */
  factsLine: string | null;
};

const FACT_LINE = /^[-*•]\s*([A-Za-z][\w /&-]*?):\s*(.*)$/;
const EMPTY_VALUE = /^(none|nothing|n\/a|0)\b[.\s]*$/i;

export function parseRecapSummary(summary: string): RecapView {
  const lines = String(summary ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const zeroFacts: string[] = [];
  const notable: Array<{ label: string; value: string }> = [];
  const body: string[] = [];
  for (const line of lines) {
    const match = FACT_LINE.exec(line);
    if (!match) { body.push(line); continue; }
    const label = match[1].trim();
    // Narrators vary the filler verb ("None recorded/reported/noted") — strip
    // it before deciding whether the bullet carries anything.
    const value = match[2].replace(/\s*(recorded|reported|noted|observed)\.?$/i, "").trim();
    if (value === "" || EMPTY_VALUE.test(value)) zeroFacts.push(`${label} 0`);
    else notable.push({ label, value: match[2].trim() });
  }
  // No bullets parsed: not the shape we know — render the summary verbatim.
  if (zeroFacts.length === 0 && notable.length === 0) {
    return { lede: lines.join("\n"), notable: [], factsLine: null };
  }
  const lede = body.join("\n").replace(/^outcome:\s*/i, "");
  const factsLine = zeroFacts.length === 0
    ? null
    : notable.length === 0 ? "Nothing notable yet." : zeroFacts.join(" · ");
  return { lede, notable, factsLine };
}

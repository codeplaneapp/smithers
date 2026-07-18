import { isNotableEvent } from "./monitorModel.ts";

const typeOf = (event: any) => String(event?.type ?? event?.event ?? "");
const seqOf = (event: any) => Number(event?.seq ?? event?.sequence ?? event?.eventSeq ?? -1);

export function notableEventCount(events: unknown): number {
  return Array.isArray(events) ? events.filter((event) => isNotableEvent(typeOf(event))).length : 0;
}
export function latestSeqOf(events: unknown): number {
  return Array.isArray(events) ? events.reduce((latest, event) => Math.max(latest, Number.isFinite(seqOf(event)) ? seqOf(event) : -1), -1) : -1;
}
export function shouldRefreshRecap({ lastToSeq, latestNotableSeq, lastFetchedAtMs, lastAttemptAtMs, consecutiveFailures = 0, nowMs, live, inFlight }: { lastToSeq?: number; latestNotableSeq: number; lastFetchedAtMs?: number; lastAttemptAtMs?: number; consecutiveFailures?: number; nowMs: number; live: boolean; inFlight: boolean }): boolean {
  if (inFlight) return false;
  // A failed fetch leaves lastToSeq stale, so the growth trigger below would
  // re-fire on every render; hold retries behind a doubling, capped backoff.
  if (consecutiveFailures > 0 && nowMs - (lastAttemptAtMs ?? 0) < Math.min(15_000 * 2 ** (consecutiveFailures - 1), 180_000)) return false;
  if (latestNotableSeq > (lastToSeq ?? -1)) return true;
  return live && nowMs - (lastFetchedAtMs ?? 0) >= 180_000;
}
export function mergeRecapHistory<T extends { toSeq: number }>(...histories: T[][]): T[] {
  const seen = new Set<number>();
  return histories.flat().sort((a, b) => b.toSeq - a.toSeq).filter((entry) => !seen.has(entry.toSeq) && !!seen.add(entry.toSeq));
}
export function formatRecapAge(generatedAtMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - generatedAtMs) / 1000));
  return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}

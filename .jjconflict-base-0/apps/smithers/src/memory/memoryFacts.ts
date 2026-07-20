/**
 * The cross-run memory surface's types + pure domain logic: the namespaced
 * `MemoryFact` shape and the semantic-recall scorer, ported from the Swift
 * MemoryView (smithers memory). One card and one canvas read the SAME live facts
 * (hydrated by `MemoryFactsBridge` from the `listMemoryFacts` gateway RPC); the
 * Facts tab browses the table, the Recall tab scores facts against a query.
 *
 * Everything here is pure — the value previews, the relative-age formatter, the
 * namespace derivation, and the recall scorer — so they unit-test without a DOM
 * and against a fixture (see memoryDomain.test.ts). There is no in-app seed data:
 * the live facts come from the real backend.
 *
 * `factAge` defaults to the fixed NOW_MS anchor so the pure tests stay
 * clock-free; the live UI passes a real `Date.now()` so rendered ages are
 * wall-clock against the gateway's timestamps.
 */

/** The fixed "now" anchor used as `factAge`'s default (clock-free pure tests). */
export const NOW_MS = 1_717_286_400_000;

const SECOND = 1_000;

/**
 * One cross-run memory fact. `value` is a JSON string (the stored payload, the
 * way the backend persists it); `text` is a derived human one-line summary that
 * the recall scorer and the chat card read. `weight` is the base relevance the
 * recall query nudges by keyword overlap.
 */
export type MemoryFact = {
  id: string;
  namespace: string;
  key: string;
  /** The stored payload, a JSON string (object, array, or quoted scalar). */
  value: string;
  /** A human one-line summary, used by recall content + the chat card. */
  text: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Time-to-live in milliseconds, present only on facts that expire. */
  ttlMs?: number;
  /** Base recall relevance, in [0, 1]; recall adds keyword-overlap on top. */
  weight: number;
};

/** A scored recall hit: the content shown, its score, and an optional provenance. */
export type RecallResult = {
  score: number;
  content: string;
  /** A single-line `namespace/key` provenance, or null when not applicable. */
  metadata: string | null;
};

/**
 * The distinct namespaces present in the facts, sorted alphabetically. Drives
 * the namespace filter pills (port MemoryNamespaceFilterState.namespaces).
 */
export function namespaces(facts: MemoryFact[]): string[] {
  const seen = new Set<string>();
  for (const fact of facts) seen.add(fact.namespace);
  return Array.from(seen).sort();
}

/**
 * Validate a stored namespace filter against the live namespaces. A stale
 * filter (no longer present in the facts) falls back to null / All, so it can
 * never hide every row (port validatedFilter).
 */
export function validatedFilter(filter: string | null, facts: MemoryFact[]): string | null {
  if (filter === null) return null;
  return namespaces(facts).includes(filter) ? filter : null;
}

/** Keep only the facts in the active namespace; null shows every fact. */
export function factsInNamespace(facts: MemoryFact[], namespace: string | null): MemoryFact[] {
  if (namespace === null) return facts.slice();
  return facts.filter((fact) => fact.namespace === namespace);
}

/**
 * Truncate a value for the table's Value column (port factValuePreview): trim
 * whitespace, drop the wrapping double-quotes when the value is a JSON string,
 * then clip to `maxLen` with a trailing ellipsis when it is longer.
 */
export function factValuePreview(value: string, maxLen = 60): string {
  let text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

/**
 * The relative age of a fact's `updatedAtMs`, measured against the fixed NOW_MS
 * (port factAge). Buckets: <60s `{n}s ago`, <60m `{n}m ago`, <24h `{n}h ago`,
 * else `{n}d ago`. Never reads the wall clock.
 */
export function factAge(updatedAtMs: number, now = NOW_MS): string {
  const deltaSec = Math.max(0, Math.floor((now - updatedAtMs) / SECOND));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86_400)}d ago`;
}

/**
 * An absolute timestamp for the fact-detail meta block, formatted from the fixed
 * epoch with no locale or timezone dependence (so the snapshot is stable). Shape
 * is `YYYY-MM-DD HH:MM:SS` in UTC.
 */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Format a TTL as seconds with one decimal place (port the Swift `3600.0s`). */
export function formatTtl(ttlMs: number): string {
  return `${(ttlMs / 1000).toFixed(1)}s`;
}

/**
 * Pretty-print a fact's stored value for the VALUE block: JSON.parse then
 * re-serialize with 2-space indent; fall back to the raw (trimmed) string when
 * it does not parse; `(empty)` when blank.
 */
export function prettyValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "(empty)";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Clamp a recall topK up to at least 1 (port normalizedRecallTopK). */
export function normalizedRecallTopK(topK: number): number {
  if (!Number.isFinite(topK)) return 1;
  return topK < 1 ? 1 : Math.floor(topK);
}

/** Map a recall score to its color band: >=0.8 ok, >=0.5 warn, else danger. */
export function scoreTone(score: number): "score-ok" | "score-warn" | "score-danger" {
  if (score >= 0.8) return "score-ok";
  if (score >= 0.5) return "score-warn";
  return "score-danger";
}

/**
 * Rank facts for a recall query, scoped to a namespace: keyword overlap on top
 * of the base weight, sorted by score descending, sliced to topK. An empty
 * query returns the namespace's facts at their base weight (so the Recall tab
 * is useful before typing). Pure and deterministic — the scorer never touches a
 * clock or Math.random. `facts` is always passed in (the live store set); there
 * is no seed default.
 */
export function recall(
  query: string,
  facts: MemoryFact[],
  namespace: string | null = null,
  topK = 10,
): RecallResult[] {
  const scoped = factsInNamespace(facts, namespace);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const limit = normalizedRecallTopK(topK);
  return scoped
    .map((fact) => {
      const haystack = `${fact.text} ${fact.namespace} ${fact.key}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      const score = Math.min(0.99, fact.weight + hits * 0.02);
      return {
        score,
        content: fact.text,
        metadata: `${fact.namespace}/${fact.key}`,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

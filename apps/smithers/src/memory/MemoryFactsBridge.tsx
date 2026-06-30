import { useEffect } from "react";
import { useGatewayMemoryFacts } from "@smithers-orchestrator/gateway-react";
import type { GatewayMemoryFactRow } from "@smithers-orchestrator/gateway-client";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { validatedFilter, type MemoryFact } from "./memoryFacts";
import { useMemoryStore } from "./memoryStore";

/**
 * Bridge the live `memoryFacts` gateway collection into the memory store
 * (docs/p1b-plan.md §3.2). The Zustand store can't call React hooks, so this
 * component — mounted inside `<SyncProvider>` in `main.tsx` next to
 * `<CronsBridge/>` — calls `useGatewayMemoryFacts()`, maps each
 * `GatewayMemoryFactRow` onto a `MemoryFact`, and pushes the result into the
 * store on every change. Memory is READ-ONLY on the wire (only a
 * `listMemoryFacts` RPC, no write), so there is no mutation seam: facts are
 * written by runs/workflows (the `@smithers-orchestrator/memory` MemoryStore) and
 * surface here verbatim.
 *
 * We fetch EVERY namespace (no `namespace` arg) so the surface's client-side
 * namespace pills + recall scorer see the full fact set, matching the prior
 * seeded behavior; the namespace filter stays a client-side concern.
 */

/** Neutral base relevance for every live fact — there is no per-fact weight on the wire. */
const LIVE_FACT_WEIGHT = 0.75;

/**
 * Derive a human one-line summary from the stored JSON value: a quoted scalar
 * becomes its inner text; any other JSON value (object/array) falls back to its
 * first line. The recall scorer + the chat card read `text`, so it must be a
 * single human line, not the raw JSON. Pure — no clock, no DOM.
 */
export function deriveFactText(valueJson: string): string {
  const trimmed = valueJson.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
  } catch {
    // Not JSON — fall through to the raw first-line fallback.
  }
  return trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
}

/**
 * Map a live `GatewayMemoryFactRow` onto the surface's `MemoryFact`. The wire
 * carries the raw `valueJson` + timestamps; `text` is DERIVED client-side and
 * `weight` is a neutral constant (no relevance on the wire). `id` is the stable
 * `namespace:key` primary key, so an open fact's selection survives a refetch.
 * `ttlMs` is `number | null` on the wire → coalesce null to undefined so the
 * detail pane only shows a TTL block for facts that actually expire.
 */
export function toMemoryFact(row: GatewayMemoryFactRow): MemoryFact {
  return {
    id: `${row.namespace}:${row.key}`,
    namespace: row.namespace,
    key: row.key,
    value: row.valueJson,
    text: deriveFactText(row.valueJson),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    ttlMs: typeof row.ttlMs === "number" ? row.ttlMs : undefined,
    weight: LIVE_FACT_WEIGHT,
  };
}

export function MemoryFactsBridge() {
  const { data, refetch } = useGatewayMemoryFacts();

  // LOCAL-MODE freshness: the `memoryFacts` collection is pull-only (no stream),
  // so a fact written by a run/workflow after load is never pushed here. Poll the
  // small `listMemoryFacts` RPC on a modest interval (+ on focus/visibility) so
  // `/memory` reflects an out-of-band write within ~LOCAL_LIST_POLL_MS. Local-mode
  // only; the cloud path streams via Electric (P5) and this poll is removed there.
  useLocalModeRefetch(refetch);

  useEffect(() => {
    useMemoryStore.setState((state) => {
      const facts = data ? data.map(toMemoryFact) : [];
      // Reconcile the namespace filter + open fact against the new set (reusing the
      // surface's own pure validators): a namespace/fact that vanished from the
      // live store can never strand the UI on an empty view.
      const namespaceFilter = validatedFilter(state.namespaceFilter, facts);
      const selectedFactId = state.selectedFactId && facts.some((fact) => fact.id === state.selectedFactId)
        ? state.selectedFactId
        : null;
      return { facts, namespaceFilter, selectedFactId };
    });
  }, [data]);

  return null;
}

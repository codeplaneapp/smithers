/**
 * An append-only knowledge note — the sibling record type to MemoryFact.
 * Facts are mutable KV (upsert semantics); notes are immutable rows: body,
 * labels, and provenance never change after insert. `status` is the ONE
 * deliberate exception (see setNoteStatus) — a human/workflow gate writes an
 * answer about an existing note without churning its id.
 *
 * kind / tags / author are optional, policy-free labels the engine never
 * interprets. Notes carry NO ttl: knowledge dies by supersession or
 * rejection, not by clock.
 */
export type MemoryNote = {
  id: string;
  namespace: string;
  body: string;
  kind?: string | null;
  /** JSON-encoded string array; null when the note has no tags. */
  tagsJson?: string | null;
  author?: string | null;
  status: string;
  statusChangedAtMs?: number | null;
  createdAtMs: number;
  runId?: string | null;
  nodeId?: string | null;
  iteration?: number | null;
};

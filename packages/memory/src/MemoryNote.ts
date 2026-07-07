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

/** Input for saveNote — namespace as the structured object, tags as an array. */
export type SaveNoteInput = {
  namespace: import("./MemoryNamespace").MemoryNamespace;
  body: string;
  kind?: string;
  tags?: string[];
  author?: string;
  /** Free-form; defaults to "accepted". Conventionally pending|accepted|rejected. */
  status?: string;
  provenance?: import("./MemoryProvenance").MemoryProvenance;
  /**
   * Note ids this note supersedes. Junction rows are written atomically with
   * the note. Whether the superseded notes are HIDDEN depends on THIS note's
   * status: only an accepted superseder hides its targets.
   */
  supersedes?: string[];
  /** Provide to make retries idempotent; defaults to a random UUID. */
  id?: string;
};

/**
 * Read filter for listNotes/searchNotes. The DEFAULT READ CONTRACT (no filter)
 * returns notes that are (a) not superseded by an ACCEPTED note and
 * (b) status = "accepted". Filters widen:
 * - status: a specific status, a set, or "any"
 * - includeSuperseded: true returns notes even when an accepted note supersedes them
 * - kind: narrows to one kind label
 */
export type NoteReadFilter = {
  status?: string | string[] | "any";
  includeSuperseded?: boolean;
  kind?: string;
};

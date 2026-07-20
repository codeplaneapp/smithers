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

/**
 * Read filter for listNotes/searchNotes. The DEFAULT READ CONTRACT (no filter)
 * returns notes that are (a) not superseded by an ACCEPTED note and
 * (b) status = "accepted". Filters widen or narrow:
 * - status: a specific status, a set, or "any"
 * - includeSuperseded: true returns notes even when an accepted note supersedes them
 * - kind: narrows to one kind label
 * - namespace: narrows to one namespace. searchNotes is otherwise scoped by
 *   namespace KIND — it matches every namespace of that kind (all `user:*`
 *   namespaces, say), so pass this on shared databases to keep recall
 *   namespace-local. listNotes is already namespace-scoped by its argument.
 */
export type NoteReadFilter = {
  status?: string | string[] | "any";
  includeSuperseded?: boolean;
  kind?: string;
  namespace?: import("./MemoryNamespace").MemoryNamespace;
};

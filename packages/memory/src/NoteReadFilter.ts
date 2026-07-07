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

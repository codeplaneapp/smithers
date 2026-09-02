import { z } from "zod"

/*
 * Lane change (ADR 0003 — the change is the unit): the change-domain schemas
 * the card payloads in Cards.ts build from.
 *
 * A change is a document with revisions. The change id is the document; each
 * revision is a commit; everything else (checks, findings, comments,
 * verdicts) is pinned to a revision and goes stale by revision, never by
 * time. Until plue#450 records `revisions[]` the backend's change DTO
 * carries one `commit_id` and nothing else, so every revision-shaped field
 * is nullable or empty here: the UI renders the ADR's degraded wording and
 * never infers a revision from a timestamp.
 */

/**
 * One revision of a change (ADR 0003 backend shape 1, plue#450). The route
 * does not exist yet, so a payload built today always carries an empty
 * `revisions` array — the schema lands with the cards so the contract is one
 * change.
 */
export const ChangeRevisionSchema = z.object({
  seq: z.number().int().positive(),
  commitId: z.string(),
  /** What produced the revision. */
  source: z.enum(["push", "rebase", "agent", "undo"]).optional(),
  agentSessionId: z.string().optional(),
  workspaceSnapshotId: z.string().optional(),
  createdAt: z.string().optional()
})
export type ChangeRevision = z.infer<typeof ChangeRevisionSchema>

/**
 * The one pin everywhere (ADR 0003 §3): `changeId#seq (commitId)`. `seq` is
 * null until plue#450 records revisions — a card read from a local working
 * copy pins by commit id, never by a server seq.
 */
export const RevisionPinSchema = z.object({
  changeId: z.string(),
  seq: z.number().int().positive().nullable(),
  commitId: z.string().nullable()
})
export type RevisionPin = z.infer<typeof RevisionPinSchema>

/** The change card's body tabs (ADR 0003 §1). */
export const CHANGE_FACETS = ["diff", "findings", "checks", "review", "history"] as const
export const ChangeFacetSchema = z.enum(CHANGE_FACETS)
export type ChangeFacet = z.infer<typeof ChangeFacetSchema>

/** A per-file conflict (ADR 0003 shape 1 `conflicts[]`; today's conflicts route). */
export const ChangeConflictSchema = z.object({
  path: z.string(),
  /** plue's resolution_status; "unresolved" while it stands. */
  state: z.string()
})
export type ChangeConflict = z.infer<typeof ChangeConflictSchema>

/** One check row at the pinned commit (the commit-statuses route). Duration and logs have no route. */
export const ChangeCheckSchema = z.object({
  context: z.string(),
  state: z.string()
})
export type ChangeCheck = z.infer<typeof ChangeCheckSchema>

/** A review verdict on the change's landing request. `commitId` rides only once plue#453 stamps it. */
export const ChangeVerdictSchema = z.object({
  /** plue exposes reviewer_id, not a login, so author is usually null. */
  author: z.string().nullable(),
  type: z.string(),
  body: z.string(),
  commitId: z.string().nullable()
})
export type ChangeVerdict = z.infer<typeof ChangeVerdictSchema>

/** A comment thread on the change's landing request. `state` is server-computed only once plue#453 lands. */
export const ChangeThreadSchema = z.object({
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  body: z.string(),
  author: z.string().nullable(),
  createdAt: z.string().nullable(),
  state: z.enum(["current", "stale", "moved"]).nullable()
})
export type ChangeThread = z.infer<typeof ChangeThreadSchema>

/** A finding raised by an analyzer at a revision (plue#454 — no route yet; the payload field waits). */
export const ChangeFindingSchema = z.object({
  analyzer: z.string(),
  severity: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  summary: z.string(),
  /** The revision the finding was raised at; older than current reads `rev N · stale`. */
  raisedAtSeq: z.number().int().positive().nullable()
})
export type ChangeFinding = z.infer<typeof ChangeFindingSchema>

/** One file in a diff. Past 400 patch lines the hunk rides by reference, never inline. */
export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  /** plue's change_type (added, modified, deleted, renamed, copied). */
  changeType: z.string(),
  isBinary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** The unified patch, present only at or under the inline cap. */
  patch: z.string().optional(),
  /** Over the cap: the hunk count, and the card re-reads this one file explicitly. */
  patchLines: z.number().int().nonnegative().optional(),
  /** A conflicted file leads the list with an ember marker (the change's conflicts[]). */
  conflicted: z.boolean().optional()
})
export type DiffFile = z.infer<typeof DiffFileSchema>

/**
 * The diff the change card's Diff facet and the `diff` card both render
 * (ADR 0003 §1): `from → to` in the picker's own tokens ("parent", "current",
 * or "rev N" once revisions exist) and the files. Interdiff (`rev 3 → rev 5`)
 * is plue#451; today only `parent → current` has a route.
 */
export const ChangeDiffSchema = z.object({
  from: z.string(),
  to: z.string(),
  files: z.array(DiffFileSchema)
})
export type ChangeDiff = z.infer<typeof ChangeDiffSchema>

/** A changeset member (ADR 0003's live DTO): `repository · path`, the mount under /workspace/<org>/<repo>. */
export const ChangesetMemberSchema = z.object({
  repository: z.string(),
  path: z.string(),
  changeId: z.string(),
  commitId: z.string(),
  targetBookmark: z.string(),
  previousCommitId: z.string().nullable(),
  landedCommitId: z.string().nullable()
})
export type ChangesetMember = z.infer<typeof ChangesetMemberSchema>

/** The changeset a change renders from its own state until plue#452 lands (ADR 0003's live DTO). */
export const ChangesetStateSchema = z.object({
  id: z.number().int(),
  organization: z.string(),
  /** The superproject change the changeset itself is. */
  changeId: z.string(),
  state: z.enum(["pending", "landing", "landed", "failed"]),
  /** Rendered verbatim under the header on `failed`, with a Retry land (confirm). */
  failureReason: z.string().nullable(),
  targetBookmark: z.string(),
  members: z.array(ChangesetMemberSchema)
})
export type ChangesetState = z.infer<typeof ChangesetStateSchema>

/**
 * A content-addressed reference to one persisted task output row.
 *
 * `digest` is SHA-256 over the canonical JSON form of the user-visible row
 * (reserved `runId`/`nodeId`/`iteration` columns are excluded).
 */
type ProofBinding = {
    table: string;
    nodeId: string;
    iteration: number;
    digest: string;
};

export type { ProofBinding };

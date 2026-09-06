import { BTreeIndex, createLiveQueryCollection, eq, isUndefined } from "@tanstack/db"
import type { Card, CloudWorkspaceInput, CloudWorkspaceRow, WorkingCopy } from "./AppState"
import type { StoredCollections } from "./AppStore"

/** The workspace row owns header facts; the card owns its loaded facets. */
export const workspaceCardFacts = (workspace: CloudWorkspaceInput) => ({
  workspaceId: workspace.id,
  repo: workspace.repoId,
  name: workspace.name,
  targetBookmark: workspace.targetBookmark,
  status: workspace.status,
  failureCode: workspace.failureCode ?? null,
  failureMessage: workspace.failureMessage ?? null,
  provisioningStage: workspace.provisioningStage,
  suspendedAt: workspace.suspendedAt,
  workspaceKind: workspace.kind ?? null,
  agentSessionId: workspace.agentSessionId ?? null,
  head: workspace.head ?? null,
  ahead: workspace.ahead ?? null,
  behind: workspace.behind ?? null,
  startedAt: workspace.startedAt ?? null,
  environment: workspace.environment ?? null,
  persistence: workspace.persistence ?? null,
  sshHost: workspace.sshHost ?? null,
  desktop: workspace.desktop ?? null,
  lspLanguages: workspace.lspLanguages ?? null
})

export const projectWorkspaceCard = (card: Card, workspace: CloudWorkspaceInput | undefined): Card =>
  card.kind !== "workspace" || card.payload.snapshot === true || workspace === undefined ? card : {
    ...card,
    title: `${workspace.name} · ${workspace.repoId}`,
    payload: { ...card.payload, ...workspaceCardFacts(workspace) }
  }

/** Historical cards retain their captured facts, even when restored into a live branch. */
export const snapshotCard = (card: Card): Card =>
  card.kind === "workspace"
    ? { ...card, payload: { ...card.payload, snapshot: true } }
    : card

const workspaceCopy = (workspace: CloudWorkspaceRow): WorkingCopy => ({
  id: `workspace:${workspace.id}`,
  repoId: workspace.repoId,
  kind: "workspace",
  label: workspace.name,
  workspaceId: workspace.id,
  state: workspace.status,
  updatedAt: workspace.updatedAt,
  revision: workspace.revision
})

/** Materialized views, never persisted or written by reducers. */
export const createWorkspaceViews = (
  stored: Pick<StoredCollections, "cards" | "workingCopies" | "cloudWorkspaces">
) => {
  stored.cloudWorkspaces.createIndex((workspace) => workspace.id, { indexType: BTreeIndex })
  return {
    cards: createLiveQueryCollection({
      id: "app-live-cards",
      startSync: true,
      gcTime: Infinity,
      getKey: (card) => card.id,
      query: (q) =>
        q
          .from({
            entry: q.from({ card: stored.cards }).fn.select(({ card }) => ({
              card,
              workspaceId: card.kind === "workspace" ? card.payload.workspaceId : undefined
            }))
          })
          .leftJoin(
            { workspace: stored.cloudWorkspaces },
            ({ entry, workspace }) => eq(entry.workspaceId, workspace.id)
          )
          .fn.select(({ entry, workspace }): Card => projectWorkspaceCard(entry.card, workspace))
    }),
    workingCopies: createLiveQueryCollection({
      id: "app-live-working-copies",
      startSync: true,
      gcTime: Infinity,
      getKey: (copy) => copy.id,
      query: (q) =>
        q.unionAll(
          q.from({ copy: stored.workingCopies })
            .leftJoin(
              { workspace: stored.cloudWorkspaces },
              ({ copy, workspace }) => eq(copy.workspaceId, workspace.id)
            )
            // Local pins and sparse legacy inventory remain readable. A full
            // workspace row always supersedes an older persisted copy.
            .where(({ workspace }) => isUndefined(workspace.id))
            .select(({ copy }) => copy),
          q.from({ cloud: stored.cloudWorkspaces }).fn.select(({ cloud }) => workspaceCopy(cloud))
        )
    })
  }
}

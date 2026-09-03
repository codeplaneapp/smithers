export const REPOSITORY_ACCESS_VALUES = ["read", "read-write"] as const
export type RepositoryAccess = (typeof REPOSITORY_ACCESS_VALUES)[number]

export interface LocalRepositoryInspection {
  readonly root: string
  readonly name: string
  readonly head: string | null
  readonly branch: string | null
  readonly remoteUrl: string | null
}

/**
 * A repository selected by the native host. The capability is deliberately
 * absent from persisted connector rows and is consumed once by
 * `POST /api/repo/open`.
 */
export interface AuthorizedLocalRepositoryInspection extends LocalRepositoryInspection {
  readonly authorizationId: string
}

export type LocalRepositorySelectionError = {
  readonly status: "error"
  readonly code:
    | "native-required"
    | "not-a-directory"
    | "not-a-repository"
    | "permission-denied"
    | "inspection-failed"
  readonly message: string
}

export type InspectLocalRepositoryResult =
  | { readonly status: "connected"; readonly repository: LocalRepositoryInspection }
  | LocalRepositorySelectionError

export type PickLocalRepositoryResult =
  | { readonly status: "connected"; readonly repository: AuthorizedLocalRepositoryInspection }
  | { readonly status: "cancelled" }
  | LocalRepositorySelectionError

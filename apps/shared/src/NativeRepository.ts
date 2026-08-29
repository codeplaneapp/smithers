export const REPOSITORY_ACCESS_VALUES = ["read", "read-write"] as const
export type RepositoryAccess = (typeof REPOSITORY_ACCESS_VALUES)[number]

export interface LocalRepositoryInspection {
  readonly root: string
  readonly name: string
  readonly head: string | null
  readonly branch: string | null
  readonly remoteUrl: string | null
}

export type PickLocalRepositoryResult =
  | { readonly status: "connected"; readonly repository: LocalRepositoryInspection }
  | { readonly status: "cancelled" }
  | {
    readonly status: "error"
    readonly code:
      | "native-required"
      | "not-a-directory"
      | "not-a-repository"
      | "permission-denied"
      | "inspection-failed"
    readonly message: string
  }

/** The private-alpha catalog shared by the public site and the app backend. */
export const PUBLIC_REPOS_PATH = "/api/public/repos"

/**
 * Availability is curated; submitting a request never adds a repository here.
 * At launch only Smithers is available. The roster grows as maintainers claim
 * their repositories. The catalog order is the response order.
 */
export const AVAILABLE_REPOS = [
  {
    name: "smithersai/smithers",
    title: "Smithers",
    url: "https://github.com/smithersai/smithers",
    // The Smithers Cloud mirror namespace that answers anonymous reads. The
    // backend serves the public mirror under this path and refuses the GitHub
    // name without credentials. Never part of the public catalog response.
    cloudRepo: "smithers-canary/smithers"
  }
] as const

/**
 * Resolves a catalog repository name to its Smithers Cloud mirror path.
 * GitHub names are case-insensitive. A name outside the catalog has no mirror.
 */
export const cloudRepoFor = (name: string): string | undefined => {
  const lower = name.toLowerCase()
  return AVAILABLE_REPOS.find((repo) => repo.name.toLowerCase() === lower)?.cloudRepo
}

export interface PublicRepoStats {
  readonly stars: number
  readonly forks: number
  /** GitHub's open_issues_count includes both issues and pull requests. */
  readonly openIssuesAndPulls: number
  readonly language: string | null
  readonly license: string | null
}

export interface PublicRepository {
  readonly name: string
  readonly title: string
  readonly url: string
  readonly stats: PublicRepoStats | null
}

export interface PublicRepoCatalog {
  readonly repos: ReadonlyArray<PublicRepository>
}

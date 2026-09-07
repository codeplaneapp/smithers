/** The private-alpha catalog shared by the public site and the app backend. */
export const PUBLIC_REPOS_PATH = "/api/public/repos"

/**
 * Availability is curated; submitting a request never adds a repository here.
 * Smithers comes first, followed by its direct production dependencies.
 * The catalog order is the response order.
 */
export const AVAILABLE_REPOS = [
  { name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers" },
  { name: "wevm/incur", title: "incur", url: "https://github.com/wevm/incur" },
  { name: "Effect-TS/effect", title: "Effect", url: "https://github.com/Effect-TS/effect" }
] as const

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

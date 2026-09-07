/*
 * Fills the GitHub stats slots of every repository card under `root` from the
 * public catalog (apps/server, PUBLIC_REPOS_PATH). Shared by the landing page's
 * card grid (AvailableRepos.astro) and the coming-soon repository page
 * (ComingSoonRepo.astro), so both read one response shape and fail the same way.
 *
 * A card is an element with `data-repo="<owner>/<name>"` holding a
 * `[data-stats]` list with `[data-stat="stars|forks|openIssuesAndPulls"]`
 * values, a `[data-meta]` slot for language and license, and a
 * `[data-stats-status]` line. `root.dataset.endpoint` is the catalog URL.
 */
import type { PublicRepoCatalog } from "../../../server/src/publicRepoCatalog"

const number = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export const fillRepoStats = async (root: HTMLElement): Promise<void> => {
  const cards = [...root.querySelectorAll<HTMLElement>("[data-repo]")]
  const showUnavailable = () => {
    for (const card of cards) {
      card.querySelector("[data-stats]")?.setAttribute("aria-busy", "false")
      card.querySelector<HTMLElement>("[data-stats-status]")!.textContent = "Stats unavailable"
    }
  }
  try {
    const response = await fetch(root.dataset.endpoint!, { credentials: "omit", signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error()
    const data = await response.json() as PublicRepoCatalog
    if (!Array.isArray(data.repos)) throw new Error()
    // A catalog served before comingSoon shipped leaves those cards at "Stats unavailable".
    const entries = [...data.repos, ...(Array.isArray(data.comingSoon) ? data.comingSoon : [])]
    showUnavailable()
    for (const card of cards) {
      const stats = entries.find((repo) => repo.name === card.dataset.repo)?.stats
      if (!stats || !validCount(stats.stars) || !validCount(stats.forks) || !validCount(stats.openIssuesAndPulls)) continue
      for (const key of ["stars", "forks", "openIssuesAndPulls"] as const) {
        const value = card.querySelector<HTMLElement>(`[data-stat="${key}"]`)!
        value.textContent = number.format(stats[key])
        value.title = stats[key].toLocaleString("en")
      }
      card.querySelector<HTMLElement>("[data-meta]")!.textContent = [stats.language, stats.license].filter((value) => typeof value === "string" && value).join(" · ")
      card.querySelector<HTMLElement>("[data-stats-status]")!.textContent = ""
    }
  } catch {
    showUnavailable()
  }
}

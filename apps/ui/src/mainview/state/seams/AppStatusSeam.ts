/*
 * The GitHub App status seam: GET /api/repos/{owner}/{repo}/github-app-status
 * answers {github_app_installed, github_app_configured, install_url}. The
 * answer is a transcript message (with the install link when missing), not a
 * card — one fact, one line. A 401 here means GitHub isn't connected, not
 * that the App is uninstalled (multi src/smithersCloud/githubAppStatus.ts).
 */
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

export interface AppStatusSeam {
  readonly checkGitHubApp: (repo?: string) => Promise<string | void>
}

/** Only the github.com https install origin is worth linking (multi githubInstallUrl.ts). */
const trustedInstallUrl = (value: string): string | null => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null
  } catch {
    return null
  }
}

export const createAppStatusSeam = (ctx: SeamContext): AppStatusSeam => ({
  checkGitHubApp: async (explicit) => {
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const [owner = "", name = ""] = target.repo.split("/")
    let response: Response
    try {
      response = await ctx.http(
        `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/github-app-status`
      )
    } catch {
      return `The GitHub App status for ${target.repo} couldn't be read — the platform didn't answer.`
    }
    if (response.status === 401) {
      return `GitHub isn't connected for ${target.repo} — sign in with GitHub first, then check again.`
    }
    if (!response.ok) {
      return readErrorMessage(
        response,
        `The GitHub App status for ${target.repo} couldn't be read right now.`
      )
    }
    const body = (await response.json().catch(() => undefined)) as
      | { github_app_installed?: unknown; github_app_configured?: unknown; install_url?: unknown }
      | undefined
    if (
      typeof body?.github_app_installed !== "boolean" ||
      typeof body.github_app_configured !== "boolean" ||
      typeof body.install_url !== "string"
    ) {
      return `The GitHub App status answer for ${target.repo} was malformed.`
    }
    if (body.github_app_installed) {
      ctx.dispatch({
        type: "message.appended",
        actor: "system",
        text: `The Smithers GitHub App is installed on ${target.repo} — checks and landings are fully wired.`
      })
      return undefined
    }
    const installUrl = trustedInstallUrl(body.install_url)
    ctx.dispatch({
      type: "message.appended",
      actor: "system",
      text: installUrl === null
        ? `The Smithers GitHub App is not installed on ${target.repo}, and the platform's install link wasn't usable.`
        : `The Smithers GitHub App is not installed on ${target.repo} — checks and landings stay degraded until it is. Install it here: ${installUrl}`
    })
    return undefined
  }
})

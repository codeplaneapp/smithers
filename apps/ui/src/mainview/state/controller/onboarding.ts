/*
 * The repository welcome and its three answers.
 *
 * Any time a repository is opened the transcript opens on one card: "Welcome
 * to Smithers. owner/repo is <the catalog's one sentence>." followed by "I am"
 * and three buttons. Each button is the button door of one flow
 * (repo.maintain, repo.contribute, repo.explore), which the slash menu and the
 * agent reach through the same registry entry (THE THREE-DOOR LAW).
 *
 * Maintaining and contributing need GitHub: a human's invocation while the
 * identity answer is definitively signed-out parks the flow (the requirement
 * axis' durable deferral) and renders the sign-in step (auth.prompt); the
 * signed-in answer resumes the parked flow across the OAuth redirect, so the
 * button the visitor pressed is what runs once they are back. The model's
 * invocation renders the step and fails honestly, since a model must not
 * enqueue work that fires after its turn ends.
 *
 * Nothing here is invented: the activity sentence comes from the public
 * activity route or the card says it is not available yet; the guide
 * documents are the ones the repository holds, read through the same public
 * contents route files.read uses.
 */
import { publicRepoActivityPath } from "@smthrs/rpc/AgentApiRoutes"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "../seams/SeamContext"
import type { ControllerContext } from "./context"

type OnboardingCard = Extract<Card, { kind: "repo-onboarding" }>
type OnboardingPayload = OnboardingCard["payload"]
type Activity = NonNullable<Extract<OnboardingPayload, { stage: "maintain" }>["activity"]>

export type Answer = Promise<string | void | { readonly value: string }>

export interface OnboardingController {
  /** `repo.welcome [owner/repo]`: the opener card with the three doors. */
  readonly welcomeRepo: (repo?: string) => Answer
  /** `repo.maintain [owner/repo]`: sign-in when signed out, then the activity sentence and the maintainer's reads. */
  readonly maintainRepo: (repo?: string) => Answer
  /** `repo.contribute [owner/repo]`: sign-in when signed out, then the three contributor doors. */
  readonly contributeRepo: (repo?: string) => Answer
  /** `repo.explore [owner/repo]`: what the wiki is, the repository's guide documents, and the invitation to ask. */
  readonly exploreRepo: (repo?: string) => Answer
  /** `feature.prototype <request> [owner/repo]`: one read-only chat turn that sketches the feature. */
  readonly prototypeFeature: (request: string, repo?: string) => Answer
}

export interface OnboardingDependencies {
  readonly nextOrdinal: () => number
  /** The requirement axis' durable park (AppController.deferCommand). */
  readonly deferCommand: (name: string, args: string | null, requirement: string) => void
  /** The sign-in step, rendered into the chat (auth.prompt). */
  readonly promptSignIn: () => void
  /** The composer's submit: the human's turn on the sketch prompt. */
  readonly send: (text: string) => void
}

/** The maintainer's reads, in button order; only the ones this host registers reach the card. */
export const MAINTAINER_FLOWS: ReadonlyArray<string> = ["issues.list", "prs.list", "runs.list", "triggers.list"]

/** The guide documents an explore looks for at the repository root, in display order. */
const ROOT_GUIDES: ReadonlyArray<string> = ["README.md", "CONTRIBUTING.md", "llms.txt"]
/** The docs index an explore looks for inside a `docs` directory. */
const DOCS_INDEXES: ReadonlyArray<string> = ["README.md", "index.md"]

export const ACTIVITY_UNAVAILABLE = "Recent activity is not available yet."
export const NO_CONTRIBUTING_GUIDE = "This repository has no CONTRIBUTING.md."

/** The sentence the welcome speaks: the catalog's summary as a predicate of the repository name. */
export const welcomeSentence = (repo: string, summary: string | null): string =>
  summary === null ? `Welcome to Smithers. This is ${repo}.` : `Welcome to Smithers. ${repo} is ${summary}`

/**
 * The catalog's sentence names the product ("Smithers is a durable …"); the
 * welcome names the repository ("smithersai/smithers is a durable …"), so a
 * leading "<name> is " comes off when it is the repository's own short name.
 */
export const summaryPredicate = (repo: string, summary: string | undefined): string | null => {
  if (summary === undefined) return null
  const text = summary.trim()
  if (text === "") return null
  const name = repo.slice(repo.indexOf("/") + 1).toLowerCase()
  const match = /^(\S+)\s+is\s+(.+)$/s.exec(text)
  if (match !== null && match[1]!.toLowerCase() === name) return match[2]!
  return text
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null

/** The activity answer as the card carries it, or null when the body is not the route's contract. */
export const parseActivity = (body: unknown): Activity | null => {
  if (!isRecord(body) || typeof body.sentence !== "string" || body.sentence.trim() === "") return null
  if (!isRecord(body.counts)) return null
  const commits = asCount(body.counts.commits)
  const pullRequests = asCount(body.counts.pullRequests)
  const issues = asCount(body.counts.issues)
  if (commits === null || pullRequests === null || issues === null) return null
  return {
    sentence: body.sentence.trim(),
    counts: { commits, pullRequests, issues },
    since: typeof body.since === "string" ? body.since : ""
  }
}

export const createOnboardingController = (ctx: ControllerContext, deps: OnboardingDependencies): OnboardingController => {
  const { store } = ctx

  const upsert = (id: string, title: string, payload: OnboardingPayload): void => {
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id,
        kind: "repo-onboarding",
        title,
        status: "active",
        createdAt: Date.now(),
        ordinal: deps.nextOrdinal(),
        payload
      }
    })
  }

  const contentsUrl = (repo: string, path: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`
    return path === "" ? base : `${base}/${path.split("/").map(encodeURIComponent).join("/")}`
  }

  /**
   * The definitive signed-out answer gates; unknown or unavailable identity
   * never blocks (the seam discipline: gate on answers, not on silence).
   * Answers the refusal to hand back, or undefined when the flow may run.
   */
  const gate = (flow: string, explicit: string | undefined): string | void => {
    if (!ctx.commands.state().signedOut) return
    if (ctx.commandActor === "user") deps.deferCommand(flow, explicit ?? null, "signed-in")
    deps.promptSignIn()
    return ctx.commandActor === "user"
      ? undefined
      : "Sign in with GitHub first. The sign-in step is already rendered in the chat; point the user at it."
  }

  /** The directory listing's entry names, or the refusal for why it could not be read. */
  const listNames = async (repo: string, path: string): Promise<ReadonlyArray<{ name: string; type: string }> | string> => {
    let response: Response
    try {
      response = await ctx.boundedFetch(contentsUrl(repo, path))
    } catch (error) {
      return `The repository's files could not be listed: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) return readErrorMessage(response, `The repository's files could not be listed (HTTP ${response.status}).`)
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) return "The repository's file listing was unreadable."
    return body.flatMap((entry) =>
      isRecord(entry) && typeof entry.name === "string" && typeof entry.type === "string" ? [{ name: entry.name, type: entry.type }] : []
    )
  }

  const welcomeRepo: OnboardingController["welcomeRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const summary = summaryPredicate(repo, store.collections.repositories.get(repo)?.summary)
    upsert(`repo-welcome-${repo}`, `Welcome · ${repo}`, { stage: "welcome", repo, summary })
    return {
      value: `${welcomeSentence(repo, summary)} The card asks whether they are maintaining this repo (repo.maintain), contributing to it (repo.contribute), or just exploring (repo.explore).`
    }
  }

  const maintainRepo: OnboardingController["maintainRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const gated = gate("repo.maintain", explicit)
    if (gated !== undefined || ctx.commands.state().signedOut) return gated
    let activity: Activity | null = null
    let reason: string | undefined
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${publicRepoActivityPath(repo)}`)
      if (response.status === 404) reason = ACTIVITY_UNAVAILABLE
      else if (!response.ok) reason = await readErrorMessage(response, `Recent activity could not be read (HTTP ${response.status}).`)
      else {
        activity = parseActivity(await response.json().catch(() => null))
        if (activity === null) reason = "The recent-activity answer was malformed."
      }
    } catch (error) {
      reason = `Recent activity could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
    const flows = MAINTAINER_FLOWS.filter((name) => ctx.commands.find(name) !== undefined)
    upsert(`repo-maintain-${repo}`, `Maintaining · ${repo}`, {
      stage: "maintain",
      repo,
      activity,
      ...(reason === undefined ? {} : { reason }),
      flows
    })
    return {
      value: `${activity?.sentence ?? reason ?? ACTIVITY_UNAVAILABLE}${
        flows.length === 0 ? "" : ` The card offers ${flows.join(", ")}.`
      }`
    }
  }

  const contributeRepo: OnboardingController["contributeRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const gated = gate("repo.contribute", explicit)
    if (gated !== undefined || ctx.commands.state().signedOut) return gated
    const names = await listNames(repo, "")
    const guide = typeof names === "string"
      ? null
      : names.find((entry) => entry.type === "file" && entry.name.toLowerCase() === "contributing.md")?.name ?? null
    const reason = typeof names === "string" ? names : guide === null ? NO_CONTRIBUTING_GUIDE : undefined
    upsert(`repo-contribute-${repo}`, `Contributing · ${repo}`, {
      stage: "contribute",
      repo,
      guide,
      ...(reason === undefined ? {} : { reason })
    })
    return {
      value: `The card offers issues.create (report an issue), feature.prototype (prototype a feature request)${
        guide === null ? `; ${reason}` : `, and files.read ${guide} (learn more about contributing)`
      }`
    }
  }

  const exploreRepo: OnboardingController["exploreRepo"] = async (explicit) => {
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const root = await listNames(repo, "")
    const guides: Array<{ path: string }> = []
    let reason: string | undefined
    if (typeof root === "string") reason = root
    else {
      for (const wanted of ROOT_GUIDES) {
        const found = root.find((entry) => entry.type === "file" && entry.name.toLowerCase() === wanted.toLowerCase())
        if (found !== undefined) guides.push({ path: found.name })
      }
      const docs = root.find((entry) => entry.type === "dir" && entry.name.toLowerCase() === "docs")
      if (docs !== undefined) {
        const inside = await listNames(repo, docs.name)
        if (typeof inside !== "string") {
          for (const wanted of DOCS_INDEXES) {
            const found = inside.find((entry) => entry.type === "file" && entry.name.toLowerCase() === wanted.toLowerCase())
            if (found !== undefined) {
              guides.push({ path: `${docs.name}/${found.name}` })
              break
            }
          }
        }
      }
      if (guides.length === 0) reason = `${repo} holds none of the guide documents Smithers looks for (README.md, CONTRIBUTING.md, llms.txt, a docs index).`
    }
    upsert(`repo-explore-${repo}`, `Exploring · ${repo}`, {
      stage: "explore",
      repo,
      guides,
      ...(reason === undefined ? {} : { reason })
    })
    return {
      value: guides.length === 0
        ? `${reason ?? ""} Ask any question about ${repo} in the chat.`.trim()
        : `The wiki is ${repo}'s generated guide for humans and agents; Smithers has not generated one yet, so the card lists the repository's guide documents: ${
          guides.map((guide) => guide.path).join(", ")
        }. Ask any question about ${repo} in the chat.`
    }
  }

  const prototypeFeature: OnboardingController["prototypeFeature"] = async (request, explicit) => {
    const what = request.trim()
    if (what === "") return "feature.prototype needs what the feature should do"
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const brief =
      `Sketch a feature for ${repo}, read-only: ${what}. Describe what it should do, where in the repository it would live, and the smallest first step. Do not create a workspace, a branch, or a pull request.`
    // The model is already the turn: the sketch is its own next answer, never a nested turn.
    if (ctx.commandActor === "smithers") return { value: brief }
    deps.send(brief)
  }

  return { welcomeRepo, maintainRepo, contributeRepo, exploreRepo, prototypeFeature }
}

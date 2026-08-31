import type { AppBootstrap } from "smithers-shared/AppBootstrap"
import type { Harness, LocalRepositoryConnector, Message, Repo, Suggestion } from "./state/AppState"

/*
 * The opening entry of a session: "Smithers initialized successfully", derived
 * (never stored) from what the host actually registered — the bootstrap
 * contract, the flow registry, the harness snapshot, the repositories — and
 * the one next step, selecting a repository. Same discipline as the derived
 * auth message in App.tsx: a projection of live collections, gone the moment
 * the state it reads changes.
 */

export const INIT_MESSAGE_ID = "init-state"
export const INIT_TITLE = "Smithers initialized successfully"
export const SELECT_REPO_LABEL = "Select a repo"

/** How the session selects a repository: the native folder picker, the GitHub chooser, or nothing to ask. */
export type RepoStep = "local" | "cloud" | "none"

export interface InitFacts {
  readonly bootstrap: AppBootstrap | undefined
  readonly flowCount: number
  readonly harnesses: ReadonlyArray<Harness>
  readonly connectors: ReadonlyArray<Pick<LocalRepositoryConnector, "name" | "branch">>
  readonly repos: ReadonlyArray<Pick<Repo, "name">>
  readonly repoStep: RepoStep
}

/** Structured fields used only by the derived opening-message projection. */
export interface InitMessage extends Message {
  readonly details: string
  readonly prompt?: string
}

const REPO_STEP_FLOW: Readonly<Record<Exclude<RepoStep, "none">, string>> = {
  local: "repo.open",
  cloud: "repos.watch"
}

export const repoStep = (input: {
  readonly localPickerAvailable: boolean
  readonly connectors: ReadonlyArray<unknown>
  readonly repos: ReadonlyArray<unknown>
  readonly needsSelection: boolean
}): RepoStep => {
  /*
   * A repository already open or connected answers the step, whatever the
   * GitHub watch list says: the pill used to fall through to "cloud" on a
   * signed-in session after a local repo opened, so "Select a repo" stayed
   * on screen after the user had just selected one.
   */
  if (input.connectors.length > 0 || input.repos.length > 0) return "none"
  if (input.localPickerAvailable) return "local"
  return input.needsSelection ? "cloud" : "none"
}

/** The "Select a repo" pill for the step, or none. */
export const repoSuggestion = (step: RepoStep): ReadonlyArray<Suggestion> =>
  step === "none"
    ? []
    : [{ id: "select-repo", label: SELECT_REPO_LABEL, flow: REPO_STEP_FLOW[step], emphasis: "primary" }]

const harnessLine = (harness: Harness): string => {
  const account = harness.account?.email ?? harness.account?.label
  return `${harness.displayName} (${harness.status}${account === undefined ? "" : `, ${account}`})`
}

export const initMessage = (facts: InitFacts): InitMessage => {
  const { bootstrap } = facts
  const hostLine = bootstrap === undefined
    ? "Host: unknown"
    : `Host: ${bootstrap.host} (${bootstrap.version} ${bootstrap.buildSha.slice(0, 7)})${
      bootstrap.sandbox === null ? "" : `, sandbox ${bootstrap.sandbox.mode} on ${bootstrap.sandbox.platform}`
    }`
  const capabilities = bootstrap === undefined || bootstrap.capabilities.length === 0
    ? "none"
    : bootstrap.capabilities.join(", ")
  const harnesses = facts.harnesses.length === 0 ? "none detected" : facts.harnesses.map(harnessLine).join(", ")
  const repositories = [
    ...facts.repos.map((repo) => repo.name),
    ...facts.connectors.map((connector) => `${connector.name}${connector.branch === null ? "" : ` @ ${connector.branch}`}`)
  ]
  const detailLines = [
    `- ${hostLine}`,
    `- Capabilities: ${capabilities}`,
    `- Flows registered: ${facts.flowCount}`,
    `- Harnesses: ${harnesses}`,
    `- Repositories: ${repositories.length === 0 ? "none open" : repositories.join(", ")}`
  ]
  const prompt = facts.repoStep === "none" ? undefined : "Select a repo to get started."
  const lines = [`**${INIT_TITLE}**`, "", ...detailLines]
  if (prompt !== undefined) lines.push("", prompt)
  return {
    id: INIT_MESSAGE_ID,
    role: "smithers",
    text: lines.join("\n"),
    details: detailLines.join("\n"),
    ...(prompt === undefined ? {} : { prompt }),
    status: "complete",
    ...(facts.repoStep === "none"
      ? {}
      : { action: { flow: REPO_STEP_FLOW[facts.repoStep], label: SELECT_REPO_LABEL } }),
    /* Before every stored row and the derived auth message (createdAt 0). */
    createdAt: -1,
    ordinal: 0
  }
}

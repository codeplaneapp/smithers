import { APPROVAL_DECISION_PATH, WORKFLOW_PROVISION_PATH, WORKFLOW_RPC_PATH } from "smithers-shared/AgentApiRoutes"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { ZERO_BALANCE_EXHAUSTED_TEXT } from "./failures"

export type WorkflowRpcResult =
  | { readonly status: "ok"; readonly payload: unknown }
  | { readonly status: "error"; readonly message: string }

export const whatHappenedWords = (result: WorkflowRpcResult): string | null => {
  if (result.status !== "ok") return null
  const payload = result.payload
  if (typeof payload === "string" && payload.trim() !== "") return payload.trim()
  if (typeof payload === "object" && payload !== null) {
    for (const key of ["summary", "text", "narrative", "message"]) {
      const value = (payload as Record<string, unknown>)[key]
      if (typeof value === "string" && value.trim() !== "") return value.trim()
    }
  }
  return null
}

export interface WorkflowController {
  readonly workflowRpc: (repo: string, method: string, params: unknown) => Promise<WorkflowRpcResult>
  readonly whatHappenedWords: (result: WorkflowRpcResult) => string | null
  readonly createWorkflow: (description: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly listWorkspaceWorkflows: () => Promise<string | void | { readonly value: string }>
  readonly runWorkflow: (name: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied"
  ) => Promise<void>
}

export const createWorkflowController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  pumpWorkflowRun: (cardId: string) => Promise<void>
): WorkflowController => {
  const { store, baseUrl, boundedFetch, errorMessageOf, unref, workflowPollMs, withToast } = ctx
  const RUN_POLL_MS = workflowPollMs
  const waitMs = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      unref(timer)
    })

  const workflowIdentityGuard = (): string | undefined => {
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in") {
      return "Sign in with GitHub first — workflows run on your own workspace."
    }
    if (!identity.allowlisted) {
      return "Workflows open up with the closed alpha — your account isn't allowlisted yet."
    }
    return undefined
  }

  /*
   * Launch Checklist D-4 / AppState.ts:290-296's ruling: chat is
   * complimentary and a $0 balance never pauses it, but a workflow run is
   * non-complimentary work — the one place the pause discipline applies.
   * `allowedToStartWork` only ever reads false after a definitive
   * "ok"/"low"/"empty" balance answer (refreshBalanceImpl), so a down or
   * unread billing seam never blocks a launch. `billing === undefined` is
   * kept as an explicit defensive branch — `seed()` (AppStore.ts) always
   * inserts `initialBillingAccount()` before the store resolves, so in
   * practice the row always exists by the time a command can run; this
   * guards the invariant rather than a state the store can actually
   * produce. The refusal is dispatched into the transcript directly (not
   * left to the generic toast channel) so it lands as an embedded chat
   * message per THE EMBED LAW regardless of whether a button, slash
   * command, or the agent triggered the launch; `surfaceCommandFailure`
   * recognizes `ZERO_BALANCE_EXHAUSTED_TEXT` and skips its toast for
   * pointer-driven triggers, so a button click doesn't double-surface the
   * same refusal as both a transcript message and a toast.
   */
  const zeroBalanceGuard = (): string | undefined => {
    const billing = store.collections.billingAccounts.get("billing")
    if (billing === undefined || billing.allowedToStartWork) return undefined
    store.dispatch({ type: "message.appended", actor: "system", text: ZERO_BALANCE_EXHAUSTED_TEXT })
    return ZERO_BALANCE_EXHAUSTED_TEXT
  }

  /**
   * The watched set is the universe: the target repo, the wave-10 chooser
   * route (nothing watched, or a repo outside the set), or — wave 12 §2, when
   * the caller opts in — the genuine question of WHICH watched repo. One
   * watched repo is not a question; more than one, with no argument, is.
   */
  const workflowTargetRepoOrAsk = (
    preferred: string | undefined,
    askWhenAmbiguous: boolean
  ): { readonly repo: string } | { readonly chooser: string | null } | { readonly ask: ReadonlyArray<string> } => {
    const watched = store.collections.watchedRepos.get("watched")
    const selected = watched?.selected ?? null
    if (selected === null || selected.length === 0) return { chooser: null }
    if (preferred !== undefined && !selected.includes(preferred)) return { chooser: preferred }
    if (preferred === undefined && askWhenAmbiguous && selected.length > 1) return { ask: selected }
    return { repo: preferred ?? selected[0] ?? "" }
  }

  /** The two-way form, for the calls that do not ask (list, run-by-name). */
  const workflowTargetRepo = (preferred?: string): { readonly repo: string } | { readonly chooser: string | null } => {
    const target = workflowTargetRepoOrAsk(preferred, false)
    return "ask" in target ? { chooser: null } : target
  }

  /** The `owner/repo` shape the seam addresses — the same one the Worker refuses past. */
  const isWorkflowRepoArg = (value: string): boolean =>
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)

  /**
   * `flow.create <description> [owner/repo]` — a trailing `owner/repo`
   * token is the target, everything before it is the description. Anything
   * that is not a repository name stays part of the description.
   */
  const splitDescriptionAndRepo = (
    input: string
  ): { readonly description: string; readonly repo?: string } => {
    const words = input.trim().split(/\s+/)
    const last = words.at(-1)
    if (words.length > 1 && last !== undefined && isWorkflowRepoArg(last)) {
      return { description: words.slice(0, -1).join(" "), repo: last }
    }
    return { description: input.trim() }
  }

  const openChooserForWorkflow = async (missing: string | null): Promise<string> => {
    await ctx.openRepoChooser()
    return missing === null
      ? "Choose which repositories I should watch first — the chooser is open."
      : `${missing} isn't one of your watched repositories — the chooser is open. Watching it is the one step that unlocks this.`
  }

  const provisionWorkspaceImpl = async (repo: string): Promise<true | string> => {
    // A 409 means mid-provision: poll to a bounded deadline, never stampede.
    const deadline = Date.now() + RUN_POLL_MS * 36
    for (;;) {
      let body: { status?: unknown; message?: unknown } | undefined
      try {
        const response = await boundedFetch(`${baseUrl}${WORKFLOW_PROVISION_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo })
        })
        if (!response.ok) {
          return await errorMessageOf(response, "The workspace couldn't be prepared.")
        }
        body = (await response.json().catch(() => undefined)) as typeof body
      } catch {
        return "The workspace couldn't be prepared — the workflow service didn't answer in time."
      }
      if (body?.status === "ready") return true
      /*
       * Wave 12 §4 — the watched set is a GITHUB set; a gateway needs a
       * Smithers Cloud repository. When they don't coincide the honest
       * answer is that fact, not the provision seam's raw HTTP failure.
       */
      if (body?.status === "no-cloud-repo") {
        return `${repo} isn't on Smithers Cloud yet, so there's no workspace to run this on. Add it there and I'll pick it up, or point me at a repo that is.`
      }
      if (body?.status === "provisioning") {
        if (Date.now() > deadline) {
          return `The workspace for ${repo} is still being prepared — try again in a moment.`
        }
        await waitMs(RUN_POLL_MS)
        continue
      }
      if (typeof body?.message === "string") return body.message
      return "The workspace couldn't be prepared."
    }
  }

  const provisionWorkspace = (repo: string): Promise<true | string> =>
    withToast(
      `flow.provision.${repo}`,
      `Preparing your ${repo} workspace…`,
      "Workspace ready",
      () => provisionWorkspaceImpl(repo)
    )

  const workflowRpc = async (repo: string, method: string, params: unknown): Promise<WorkflowRpcResult> => {
    let body:
      | {
        status?: unknown
        message?: unknown
        ok?: unknown
        payload?: unknown
        error?: { message?: unknown } | unknown
      }
      | undefined
    try {
      const response = await boundedFetch(`${baseUrl}${WORKFLOW_RPC_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, method, params })
      })
      if (!response.ok) {
        return { status: "error", message: await errorMessageOf(response, "The workspace didn't answer.") }
      }
      body = (await response.json().catch(() => undefined)) as typeof body
    } catch {
      return { status: "error", message: "The workspace didn't answer — the workflow service is unreachable." }
    }
    if (body?.ok === true) return { status: "ok", payload: body.payload }
    const gatewayError = body?.error
    if (body?.ok === false) {
      return {
        status: "error",
        message: typeof gatewayError === "object" &&
            gatewayError !== null &&
            "message" in gatewayError &&
            typeof gatewayError.message === "string"
          ? gatewayError.message
          : "The workspace refused the call."
      }
    }
    if (typeof body?.message === "string") return { status: "error", message: body.message }
    return { status: "error", message: "The workspace answered in a shape I didn't understand." }
  }

  ctx.workflowRpc = workflowRpc

  interface WorkflowSummary {
    readonly key: string
    readonly description: string | null
  }

  const parseWorkflowSummaries = (wire: unknown): WorkflowSummary[] =>
    (Array.isArray(wire) ? wire : [])
      .filter(
        (entry) => typeof entry === "object" && entry !== null && typeof (entry as { key?: unknown }).key === "string"
      )
      .map((entry) => {
        const row = entry as { key: string; description?: unknown; readableName?: unknown }
        return {
          key: row.key,
          description: typeof row.description === "string" && row.description.trim() !== "" ? row.description : null
        }
      })

  const upsertRunCard = (args: {
    readonly runId: string
    readonly repo: string
    readonly workflow: string
    readonly title: string
    readonly firstStep: string
  }): string => {
    const cardId = `flow-run-${args.runId}`
    const existing = store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "flow-run",
      title: args.title,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo: args.repo,
        runId: args.runId,
        workflow: args.workflow,
        phase: "running",
        steps: [args.firstStep],
        result: null,
        lastSeq: 0
      }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    void pumpWorkflowRun(cardId)
    return cardId
  }

  const launchWorkflow = async (args: {
    readonly repo: string
    readonly workflow: string
    readonly input: Record<string, unknown>
    readonly title: string
  }): Promise<{ readonly runId: string } | string> => {
    const launch = await workflowRpc(args.repo, "launchRun", {
      workflow: args.workflow,
      input: args.input
    })
    if (launch.status !== "ok") return launch.message
    const payload = launch.payload
    const runId =
      typeof payload === "object" && payload !== null && "runId" in payload && typeof payload.runId === "string"
        ? payload.runId
        : undefined
    if (runId === undefined) {
      return "The run started but the workspace didn't name it — nothing is lost; ask me to check."
    }
    upsertRunCard({
      runId,
      repo: args.repo,
      workflow: args.workflow,
      title: args.title,
      firstStep: `Started ${args.workflow} on ${args.repo} (run ${runId}).`
    })
    return { runId }
  }

  /*
   * Wave 12 §2 — the which-repo question, embedded. It renders only when the
   * answer is genuinely the user's (more than one watched repo, no argument);
   * one act answers it, and the create resumes with the repo they named.
   */
  const WORKFLOW_REPO_CARD_ID = "workflow-repo"

  const askWhichWatchedRepo = (
    description: string,
    repos: ReadonlyArray<string>
  ): { readonly value: string } => {
    const existing = store.collections.cards.get(WORKFLOW_REPO_CARD_ID)
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: WORKFLOW_REPO_CARD_ID,
        kind: "workflow-repo",
        title: "Which repository?",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: { intent: "create", description, repos: [...repos], chosen: null }
      }
    })
    /*
     * A QUESTION is not a failure. A bare string result marks the outcome
     * `failed`, and live on canary the transcript read "Smithers tried
     * /flow.create — failed: You watch 3 repositories…" beside the card
     * that had just asked them, correctly, which one. The command did exactly
     * what it should; the value carries the question to the model, and the
     * card carries it to the human (§2b — values never render raw).
     */
    return { value: `You watch ${repos.length} repositories — choose the one this workflow belongs to.` }
  }

  const chooseWorkflowRepo = async (fullName: string): Promise<string | void | { readonly value: string }> => {
    const card = store.collections.cards.get(WORKFLOW_REPO_CARD_ID)
    if (card === undefined || card.kind !== "workflow-repo") {
      return "There's no repository question open right now."
    }
    if (card.payload.chosen !== null) {
      // A question is answered once. Two clicks landing before the card's
      // state came back would otherwise launch the same workflow twice, on
      // a seam where a launch is real work on the user's workspace.
      return `That question is already answered — I'm creating it on ${card.payload.chosen}.`
    }
    if (!card.payload.repos.includes(fullName)) {
      return `${fullName} isn't one of the repositories in that question.`
    }
    store.dispatch({
      type: "card.updated",
      actor: "user",
      id: WORKFLOW_REPO_CARD_ID,
      patch: { payload: { ...card.payload, chosen: fullName }, status: "acted" }
    })
    return createWorkflow(card.payload.description, fullName)
  }

  const createWorkflow = async (
    rawDescription: string,
    repoArg?: string
  ): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const balanceGuard = zeroBalanceGuard()
    if (balanceGuard !== undefined) return balanceGuard
    // §2: `flow.create <description> [owner/repo]` — one argument string
    // for both the slash form and the agent tool.
    const split = repoArg === undefined
      ? splitDescriptionAndRepo(rawDescription)
      : { description: rawDescription.trim(), repo: repoArg }
    const description = split.description
    if (description === "") return "flow.create needs a description of what the workflow should do"
    const target = workflowTargetRepoOrAsk(split.repo, true)
    if ("chooser" in target) return openChooserForWorkflow(target.chooser)
    if ("ask" in target) return askWhichWatchedRepo(description, target.ask)
    const repo = target.repo
    const provisioned = await provisionWorkspace(repo)
    if (provisioned !== true) return provisioned
    /*
     * No pre-flight `listWorkflows` gate here. The live gateway populates
     * its global pack LAZILY — a cold `listWorkflows` answers with only the
     * repo's own workflows and `create-workflow` appears moments later — so
     * gating on that list refuses a workflow the workspace really has.
     * `launchRun` resolves the registry on a miss and answers NOT_FOUND
     * honestly, which is the truth worth surfacing.
     */
    const launched = await launchWorkflow({
      repo,
      workflow: "create-workflow",
      input: { prompt: description },
      title: `Creating a workflow — ${repo}`
    })
    if (typeof launched === "string") return launched
    /*
     * Wave 12 §1: a MINIMAL machine acknowledgment. Wave 11's paragraph of
     * warnings was the model's only evidence and it rounded up anyway, so the
     * result stops trying to talk the model out of lying: it states the fact
     * the client already knows, and the claim surface is the client's.
     */
    return { value: `run-started workflow=create-workflow run=${launched.runId} repo=${repo}` }
  }

  const listWorkspaceWorkflows = async (): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowTargetRepo()
    if ("chooser" in target) return openChooserForWorkflow(target.chooser)
    const repo = target.repo
    const provisioned = await provisionWorkspace(repo)
    if (provisioned !== true) return provisioned
    const list = await workflowRpc(repo, "listWorkflows", {})
    if (list.status !== "ok") return list.message
    const workflows = parseWorkflowSummaries(list.payload)
    const existing = store.collections.cards.get(`workflow-list-${repo}`)
    const card: Card = {
      id: `workflow-list-${repo}`,
      kind: "workflow-list",
      title: `Workflows — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: nextTranscriptOrdinal(),
      payload: { repo, workflows }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    return {
      value: workflows.length === 0
        ? `No workflows on ${repo} yet.`
        : `Workflows on ${repo}: ${workflows.map((workflow) => workflow.key).join(", ")}.`
    }
  }

  const runWorkflow = async (name: string, repoArg?: string): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const balanceGuard = zeroBalanceGuard()
    if (balanceGuard !== undefined) return balanceGuard
    const target = workflowTargetRepo(repoArg)
    if ("chooser" in target) return openChooserForWorkflow(target.chooser)
    const repo = target.repo
    const provisioned = await provisionWorkspace(repo)
    if (provisioned !== true) return provisioned
    // Launch first (the gateway's registry is lazy — see createWorkflow); a
    // genuine miss comes back as the gateway's own NOT_FOUND, and only then
    // is it worth naming what the workspace does have.
    const launched = await launchWorkflow({
      repo,
      workflow: name,
      input: {},
      title: `${name} — ${repo}`
    })
    if (typeof launched === "string") {
      if (!/unknown workflow/i.test(launched)) return launched
      // A genuine miss: only now is it worth naming what the workspace has.
      const list = await workflowRpc(repo, "listWorkflows", {})
      const available = list.status === "ok"
        ? parseWorkflowSummaries(list.payload)
          .map((workflow) => workflow.key)
          .slice(0, 8)
          .join(", ")
        : ""
      return `There's no workflow called ${name} on ${repo}${
        available === "" ? "." : ` — the workspace has: ${available}.`
      }`
    }
    // The same minimal acknowledgment (§1): the card is the claim surface.
    return { value: `run-started workflow=${name} run=${launched.runId} repo=${repo}` }
  }

  const forwardApprovalDecision = async (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied"
  ): Promise<void> => {
    const { runId, nodeId, iteration, repo } = card.payload
    let response: Response
    try {
      response = await boundedFetch(`${baseUrl}${APPROVAL_DECISION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          nodeId,
          iteration,
          decision: { approved: decision === "approved" },
          // Wave 11: a run's approval round-trips through the per-user
          // gateway for the repo the run lives on.
          ...(repo === undefined ? {} : { repo })
        })
      })
    } catch {
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: "The decision could not reach the engine. Nothing was recorded — try again."
      })
      return
    }
    if (!response.ok) {
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: await errorMessageOf(
          response,
          "The engine did not accept the decision. Nothing was recorded — try again."
        )
      })
      return
    }
    const echo = (await response.json().catch(() => undefined)) as
      | { runId?: unknown; nodeId?: unknown; iteration?: unknown; approved?: unknown }
      | undefined
    if (echo === undefined || typeof echo.approved !== "boolean") {
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: "The engine did not echo the decision, so nothing was recorded — try again."
      })
      return
    }
    // The card freezes from the server's echo, never from local optimism.
    store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: card.id,
      decision: echo.approved ? "approved" : "denied",
      decidedAt: Date.now()
    })
  }
  return {
    workflowRpc,
    whatHappenedWords,
    createWorkflow,
    listWorkspaceWorkflows,
    runWorkflow,
    chooseWorkflowRepo,
    forwardApprovalDecision
  }
}

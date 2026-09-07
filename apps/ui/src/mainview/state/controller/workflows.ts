import { WORKFLOW_PROVISION_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { resolveTargetRepo } from "../RepoContext"
import { readTriggers } from "../seams/TriggersSeam"
import { ZERO_BALANCE_EXHAUSTED_TEXT } from "./failures"

export interface WorkflowController {
  readonly createWorkflow: (description: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly listWorkspaceWorkflows: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The dispatchers waiting on the repository: its triggers, as an embedded card. */
  readonly listTriggers: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The Flows pane: the surface switch, and the same listing that fills it. */
  readonly showFlows: () => Promise<string | void | { readonly value: string }>
  readonly runWorkflow: (name: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied"
  ) => Promise<void>
  /*
   * Lane runs shares the workflow lane's launch path: the run inbox's open,
   * resume, and rerun acts provision the same workspace, launch through the
   * same seam, and record the run on the same card, rather than growing a
   * second launch that could drift from the one `flow.run` proves.
   */
  readonly workflowIdentityGuard: () => string | undefined
  /** The refusal a $0 balance answers a launch with, already in the transcript; undefined when work may start. */
  readonly workflowBalanceGuard: () => string | undefined
  readonly workflowTargetRepo: (preferred?: string) => { readonly repo: string } | { readonly error: string }
  readonly provisionWorkspace: (repo: string) => Promise<true | string>
  readonly upsertRunCard: (args: {
    readonly runId: string
    readonly repo: string
    readonly workflow: string
    readonly title: string
    readonly firstStep: string
    readonly input?: Record<string, unknown>
    /** The run's kind (prototype, implement); absent for every other run. */
    readonly kind?: string
  }) => string
  readonly launchWorkflow: (args: {
    readonly repo: string
    readonly workflow: string
    readonly input: Record<string, unknown>
    readonly title: string
    readonly kind?: string
  }) => Promise<{ readonly runId: string } | string>
  /** A decision made on the workspace approvals inbox, for a gate whose own card never landed. */
  readonly forwardInboxApprovalDecision: (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied"
  ) => Promise<void>
}

export const createWorkflowController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  pumpWorkflowRun: (cardId: string) => Promise<void>
): WorkflowController => {
  const { store, baseUrl, boundedFetch, errorMessageOf, gateway, unref, workflowPollMs, withToast } = ctx
  const RUN_POLL_MS = workflowPollMs
  const waitMs = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      unref(timer)
    })

  const workflowIdentityGuard = (): string | undefined => {
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in") {
      return "Sign in with GitHub first: flows run on your own workspace."
    }
    if (!identity.allowlisted) {
      return "Flows open up with the closed alpha: your account isn't allowlisted yet."
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
   * The loaded repositories are the universe (lane piper): an explicit
   * `owner/repo` names the target; otherwise one loaded repository is the
   * target, none is the honest "load one first", and several — when the
   * caller opts in (wave 12 §2) — is the genuine question of WHICH loaded
   * repository. One loaded repository is not a question; more than one, with
   * no argument, is.
   */
  const NO_REPO_LOADED =
    "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"

  const workflowTargetRepoOrAsk = (
    preferred: string | undefined,
    askWhenAmbiguous: boolean
  ): { readonly repo: string } | { readonly error: string } | { readonly ask: ReadonlyArray<string> } => {
    if (preferred !== undefined || store.session().activeRepoKey != null) return resolveTargetRepo(store, preferred)
    const loaded = [...store.collections.repositories.values()].map((repository) => repository.id)
    if (loaded.length === 0) return { error: NO_REPO_LOADED }
    if (loaded.length > 1 && askWhenAmbiguous) return { ask: loaded }
    if (loaded.length > 1) {
      return { error: `Several repositories are loaded (${loaded.join(", ")}) — name one as owner/repo` }
    }
    return { repo: loaded[0] ?? "" }
  }

  /** The two-way form, for the calls that do not ask (list, run-by-name). */
  const workflowTargetRepo = (preferred?: string): { readonly repo: string } | { readonly error: string } =>
    resolveTargetRepo(store, preferred)

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
        return "The workspace couldn't be prepared: the flow service didn't answer in time."
      }
      if (body?.status === "ready") return true
      /*
       * Wave 12 §4 — the loaded set is a GITHUB set; a gateway needs a
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

  const upsertRunCard = (args: {
    readonly runId: string
    readonly repo: string
    readonly workflow: string
    readonly title: string
    readonly firstStep: string
    readonly input?: Record<string, unknown>
    readonly kind?: string
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
        lastSeq: 0,
        ...(args.input === undefined ? {} : { input: args.input }),
        ...(args.kind === undefined ? {} : { kind: args.kind })
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
    readonly kind?: string
  }): Promise<{ readonly runId: string } | string> => {
    const launch = await gateway.launch(args.repo, args.workflow, args.input)
    if (launch.status !== "ok") return launch.message
    const { runId } = launch.value
    upsertRunCard({
      runId,
      repo: args.repo,
      workflow: args.workflow,
      title: args.title,
      firstStep: `Started ${args.workflow} on ${args.repo} (run ${runId}).`,
      input: args.input,
      ...(args.kind === undefined ? {} : { kind: args.kind })
    })
    return { runId }
  }

  /*
   * Wave 12 §2 — the which-repo question, embedded. It renders only when the
   * answer is genuinely the user's (more than one loaded repository, no
   * argument); one act answers it, and the create resumes with the repo they
   * named.
   */
  const WORKFLOW_REPO_CARD_ID = "workflow-repo"

  const askWhichRepo = (
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
     * /flow.create — failed: You have 3 repositories loaded…" beside the card
     * that had just asked them, correctly, which one. The command did exactly
     * what it should; the value carries the question to the model, and the
     * card carries it to the human (§2b — values never render raw).
     */
    return { value: `You have ${repos.length} repositories loaded. Choose the one this flow belongs to.` }
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
    if (description === "") return "flow.create needs a description of what the flow should do"
    const target = workflowTargetRepoOrAsk(split.repo, true)
    if ("error" in target) return target.error
    if ("ask" in target) return askWhichRepo(description, target.ask)
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
      title: `Creating a flow: ${repo}`
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

  const listWorkspaceWorkflows = async (repoArg?: string): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowTargetRepo(repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const provisioned = await provisionWorkspace(repo)
    if (provisioned !== true) return provisioned
    const list = await gateway.listFlows(repo)
    if (list.status !== "ok") return list.message
    const workflows = list.value.map((flow) => ({ key: flow.flowId, description: flow.description }))
    const existing = store.collections.cards.get(`workflow-list-${repo}`)
    const card: Card = {
      id: `workflow-list-${repo}`,
      kind: "workflow-list",
      title: `Flows: ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: nextTranscriptOrdinal(),
      payload: { repo, workflows }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    return {
      value: workflows.length === 0
        ? `No flows on ${repo} yet.`
        : `Flows on ${repo}: ${workflows.map((workflow) => workflow.key).join(", ")}.`
    }
  }

  /*
   * The dispatchers (triggers.list): the events the repository's runs wait
   * for. The read is the Worker's own route rather than a relayed gateway
   * procedure (the gateway relays none for triggers or webhooks yet), so no
   * workspace is provisioned for it; the route answers empty lists with its
   * reason on a deployment that cannot read the registries, and the card
   * states that reason.
   */
  const listTriggers = async (repoArg?: string): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowTargetRepo(repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const list = await readTriggers(boundedFetch, baseUrl, repo)
    if (typeof list === "string") return list
    const cardId = `trigger-list-${repo}`
    const existing = store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "trigger-list",
      title: `Triggers — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: nextTranscriptOrdinal(),
      payload: {
        repo,
        ...(list.reason === undefined ? {} : { reason: list.reason }),
        triggers: [...list.triggers],
        webhooks: [...list.webhooks]
      }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    const rows = [
      ...list.triggers.map((trigger) => `${trigger.id} runs ${trigger.flowId}`),
      ...list.webhooks.map((webhook) => `webhook ${webhook.name}${webhook.flowId === undefined ? "" : ` runs ${webhook.flowId}`}`)
    ]
    return {
      value: rows.length === 0
        ? `No triggers or webhooks on ${repo}.${list.reason === undefined ? "" : ` ${list.reason}`}`
        : `${rows.length} dispatcher${rows.length === 1 ? "" : "s"} on ${repo}: ${rows.join(", ")}.`
    }
  }

  /*
   * Ask 5 (will, 2026-09-02): "where it says connect chat and world an option
   * should also be flows which should allow us to look at flows". The pane is
   * the flow.list card's rows, so opening it IS running that list — one seam,
   * one honest refusal when a repository is not loaded or the session is not
   * signed in, and the same toggle-back the World and Connect surfaces have.
   *
   * User-only on purpose: the model already has flow.list, whose answer is an
   * embedded card. THE EMBED LAW makes the pane the human's act alone.
   */
  const showFlows = async (): Promise<string | void | { readonly value: string }> => {
    if (store.session().surface === "flows") {
      store.dispatch({ type: "surface.changed", actor: "user", surface: "chat" })
      return
    }
    store.dispatch({ type: "surface.changed", actor: "user", surface: "flows" })
    return listWorkspaceWorkflows()
  }

  const runWorkflow = async (name: string, repoArg?: string): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const balanceGuard = zeroBalanceGuard()
    if (balanceGuard !== undefined) return balanceGuard
    const target = workflowTargetRepo(repoArg)
    if ("error" in target) return target.error
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
      if (!/unknown|not found/i.test(launched)) return launched
      // A genuine miss: only now is it worth naming what the workspace has.
      const list = await gateway.listFlows(repo)
      const available = list.status === "ok"
        ? list.value.map((flow) => flow.flowId).slice(0, 8).join(", ")
        : ""
      return `There's no flow called ${name} on ${repo}${
        available === "" ? "." : `. The workspace has: ${available}.`
      }`
    }
    // The same minimal acknowledgment (§1): the card is the claim surface.
    return { value: `run-started workflow=${name} run=${launched.runId} repo=${repo}` }
  }

  /**
   * Decide one gate.
   *
   * The payload the gateway published goes back unchanged, so the client never
   * reconstructs authority, and one call records the decision AND resumes the
   * run it unblocked. The card still freezes from the server's answer, never
   * from local optimism: a decision the workspace did not take is a decision
   * the human has to be able to take again.
   */
  const forwardApprovalDecision = async (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied"
  ): Promise<void> => {
    const { repo, approval } = card.payload
    if (repo === undefined || approval === undefined) {
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: "This approval is not linked to a run, so there is nothing to send the decision to."
      })
      return
    }
    const submitted = await gateway.submitApproval(
      repo,
      approval as Parameters<typeof gateway.submitApproval>[1],
      decision === "approved" ? "approve" : "deny"
    )
    if (submitted.status !== "ok") {
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: submitted.message
      })
      return
    }
    store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: card.id,
      decision,
      decidedAt: Date.now()
    })
  }
  /**
   * A decision made on the workspace approvals inbox (lane runs §5).
   *
   * The gate the decision names belongs to a run whose approval card may
   * never have landed in this transcript — the inbox is how the human reaches
   * it anyway. The row carries the submit-ready envelope the gateway
   * published, so the decision goes back with it unchanged; the card freezes
   * from the server's answer, never from local optimism, exactly as
   * `forwardApprovalDecision` does for a per-run approval card.
   */
  const forwardInboxApprovalDecision = async (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied"
  ): Promise<void> => {
    const card = store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "approvals-inbox") return
    const row = card.payload.approvals.find((entry) => entry.requestId === requestId)
    if (row === undefined || row.decision !== undefined || row.pending === true) return
    store.dispatch({
      type: "card.updated",
      actor: "user",
      id: cardId,
      patch: {
        payload: {
          ...card.payload,
          approvals: card.payload.approvals.map((entry) => entry.requestId === requestId ? { ...entry, pending: true } : entry)
        }
      }
    })
    const submitted = await gateway.submitApproval(
      card.payload.repo,
      row.approval as Parameters<typeof gateway.submitApproval>[1],
      decision === "approved" ? "approve" : "deny"
    )
    const latest = store.collections.cards.get(cardId)
    if (latest === undefined || latest.kind !== "approvals-inbox") return
    const approvals = latest.payload.approvals.map((entry) =>
      entry.requestId === requestId
        ? submitted.status === "ok"
          ? { ...entry, decision, decisionError: undefined, pending: undefined }
          : { ...entry, decisionError: submitted.message, pending: undefined }
        : entry
    )
    store.dispatch({
      type: "card.updated",
      actor: submitted.status === "ok" ? "user" : "system",
      id: cardId,
      patch: {
        payload: { ...latest.payload, approvals },
        // The inbox is acted only when no row is still undecided.
        ...(approvals.every((entry) => entry.decision !== undefined) ? { status: "acted" as const } : {})
      }
    })
  }
  return {
    createWorkflow,
    listWorkspaceWorkflows,
    listTriggers,
    showFlows,
    runWorkflow,
    chooseWorkflowRepo,
    forwardApprovalDecision,
    workflowIdentityGuard,
    workflowBalanceGuard: zeroBalanceGuard,
    workflowTargetRepo,
    provisionWorkspace,
    upsertRunCard,
    launchWorkflow,
    forwardInboxApprovalDecision
  }
}

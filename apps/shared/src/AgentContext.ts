import { z } from "zod"

/*
 * The per-turn runtime context: a versioned, structured, freshly-derived view of
 * the host Smithers app the agent is actually running inside. The client builds
 * it anew from live collections on EVERY turn (never cached, never persisted into
 * the visible transcript), sends it alongside the turn, and the server boundary
 * renders it into the instructions the upstream model sees. It states only state
 * the client genuinely holds — surface, connectors, world-state summaries — and
 * honest limitations, so the model answers "what app am I in" from fact instead
 * of pleading ignorance about the host environment.
 */

export const AGENT_RUNTIME_CONTEXT_VERSION = 1

export const AgentRuntimeConnectorSchema = z.object({
  kind: z.string(),
  name: z.string(),
  status: z.string(),
  access: z.string(),
  root: z.string(),
  branch: z.string().nullable()
})
export type AgentRuntimeConnector = z.infer<typeof AgentRuntimeConnectorSchema>

export const AgentRuntimeWorldDocumentSchema = z.object({
  path: z.string(),
  title: z.string(),
  confidence: z.number(),
  /*
   * §10.8: the note's own words. Metadata alone made the World decorative —
   * a note recording a fact nowhere else was invisible to the model, which
   * answered "I can't retrieve that" about content the pane calls "what
   * Smithers currently understands". Optional, because the client budgets
   * how much body text rides a turn and a boundary built before this field
   * must still validate the payload.
   */
  body: z.string().optional(),
  /** True when `body` is the head of a longer note the budget cut. */
  bodyTruncated: z.boolean().optional()
})
export type AgentRuntimeWorldDocument = z.infer<typeof AgentRuntimeWorldDocumentSchema>

export const AgentRuntimeContextSchema = z.object({
  version: z.literal(AGENT_RUNTIME_CONTEXT_VERSION),
  product: z.literal("smithers"),
  // Epoch milliseconds, bounded by the ECMAScript time-value range: an
  // out-of-range number is not a timestamp, and rendering one would throw at
  // the server boundary rather than be rejected here.
  capturedAt: z.number().int().min(0).max(8_640_000_000_000_000),
  revision: z.number().int().nonnegative(),
  surface: z.enum(["chat", "world", "connectors"]),
  theme: z.enum(["light", "dark"]),
  selectedWorldDocument: z.string().nullable(),
  connectors: z.array(AgentRuntimeConnectorSchema),
  /*
   * Sign-in IS the GitHub connector — one act, one truth (Wave 10, §2a′):
   * a valid GitHub session means the GitHub connector IS connected, so the
   * model never routes a signed-in user toward "connecting GitHub" again.
   * watchedRepos is the count of the user's chosen set, "unselected" when
   * they have never chosen, and null when signed out.
   */
  github: z.object({
    connected: z.boolean(),
    login: z.string().nullable(),
    watchedRepos: z.union([z.number().int().nonnegative(), z.literal("unselected")]).nullable(),
    /*
     * The chosen repositories BY NAME. A count alone left the model
     * declining to answer "what repos do you watch?" while the names were
     * served plainly by the seam it was already reading (§22.7). Optional so
     * a boundary built before this field still validates the payload.
     */
    watchedRepoNames: z.array(z.string()).optional()
  }),
  /*
   * The account's own money, as the client already holds it. Asked "what is my
   * balance right now?", the model answered "$0.00" one line above a card its
   * own tool call had just rendered reading "$519 left" — it had no figure in
   * context and confabulated one (§22.7). Optional for the same reason.
   */
  billing: z
    .object({
      state: z.string(),
      totalUsd: z.string().nullable(),
      lifetimeChargedUsd: z.string().nullable(),
      chargeCount: z.number().int().nonnegative()
    })
    .nullable()
    .optional(),
  worldState: z.object({
    documentCount: z.number().int().nonnegative(),
    documents: z.array(AgentRuntimeWorldDocumentSchema)
  }),
  capabilities: z.array(z.string()),
  limitations: z.array(z.string())
})
export type AgentRuntimeContext = z.infer<typeof AgentRuntimeContextSchema>

/*
 * Rendering runs on the server boundary against a body that arrived over the
 * wire, so it never throws on a timestamp: a value the schema would have
 * rejected still renders as an honest "unknown" instead of turning the turn
 * into a misleading "Smithers Cloud is unreachable".
 */
const capturedAtLabel = (capturedAt: number): string =>
  Number.isFinite(capturedAt) && Math.abs(capturedAt) <= 8_640_000_000_000_000
    ? new Date(capturedAt).toISOString()
    : "unknown"

/** The hidden-context block the server boundary folds into the turn's instructions. */
export const renderAgentRuntimeContext = (context: AgentRuntimeContext): string => {
  const lines = [
    "# Runtime context — the Smithers app you are running inside (context version 1)",
    "This block was freshly derived from the host app's live state at the start of THIS turn. It is hidden context: it is not part of the visible transcript and the user cannot see it. Treat it as the complete and current truth about the environment you are operating in — never guess beyond it.",
    "- Product: Smithers. You are running INSIDE the Smithers product's own chat client, so when the user asks what app they are in, the truthful answer is Smithers.",
    `- Captured: ${capturedAtLabel(context.capturedAt)} (app-state revision ${context.revision})`,
    `- Current surface: ${context.surface}${
      context.selectedWorldDocument === null
        ? ""
        : ` (world document open: "${context.selectedWorldDocument}")`
    }${
      // Chat-first: world and connectors are panes embedded in the chat shell,
      // not pages that replaced it. Saying only "Current surface: world" would
      // read as "the conversation is gone", which is not what the user sees.
      context.surface === "chat"
        ? ""
        : " — an embedded pane inside the chat shell; the conversation transcript and composer stay visible and usable beside it"}`,
    `- Theme: ${context.theme}`
  ]
  if (context.connectors.length === 0) {
    lines.push("- Connectors: none connected — no workspace, repository, or branch is known.")
  } else {
    lines.push("- Connectors:")
    for (const connector of context.connectors) {
      lines.push(
        `  - ${connector.kind} "${connector.name}" (${connector.status}, ${connector.access} access) at ${connector.root}${
          connector.branch === null ? "" : `, branch ${connector.branch}`
        }`
      )
    }
  }
  if (context.github.connected) {
    const watched = context.github.watchedRepos === "unselected"
      ? "the user has NOT chosen which repos to watch yet — repo work routes to the repos.watch chooser, never to a sign-in they already have"
      : typeof context.github.watchedRepos === "number"
      ? `watching ${context.github.watchedRepos} chosen repo(s)`
      : "watch set unknown"
    lines.push(
      `- GitHub: CONNECTED as ${
        context.github.login ?? "a GitHub user"
      } (sign-in and the GitHub connector are one act) — ${watched}.`
    )
    const names = context.github.watchedRepoNames ?? []
    if (names.length > 0) {
      lines.push(`  Watched repositories, by name: ${names.join(", ")}.`)
    }
  } else {
    lines.push("- GitHub: not connected (no signed-in session).")
  }
  const billing = context.billing
  if (billing !== undefined && billing !== null) {
    lines.push(
      billing.state === "unavailable" || billing.state === "unknown"
        ? `- Balance: the billing service did not answer (${billing.state}) — say so rather than naming a figure.`
        : `- Balance: $${billing.totalUsd ?? "0"} left; $${
          billing.lifetimeChargedUsd ?? "0"
        } spent across ${billing.chargeCount} turn(s). This IS the number — never state a different one.`
    )
  }
  if (context.worldState.documentCount === 0) {
    lines.push("- World state: no documents yet.")
  } else {
    lines.push(
      `- World state: ${context.worldState.documentCount} document(s). These notes ARE what Smithers understands about this workspace — when the user asks about something a note records, answer from the note below, never from a repository read and never with "I can't retrieve that":`
    )
    for (const document of context.worldState.documents) {
      lines.push(`  - ${document.path} — "${document.title}" (confidence ${document.confidence})`)
      if (document.body === undefined) continue
      const body = document.body.trim()
      if (body === "") {
        lines.push(
          document.bodyTruncated === true
            ? "    | (this note's text did not fit this turn's context budget — read it in the World pane)"
            : "    (empty note)"
        )
        continue
      }
      // Indented under its own heading so a note's words cannot be read as
      // an instruction line of this block.
      for (const line of body.split("\n")) lines.push(`    | ${line}`)
      if (document.bodyTruncated === true) {
        lines.push("    | … (note truncated here — read the rest in the World pane)")
      }
    }
  }
  lines.push("- Capabilities (what you can honestly do in this client):")
  for (const capability of context.capabilities) lines.push(`  - ${capability}`)
  lines.push("- Limitations (never claim otherwise):")
  for (const limitation of context.limitations) lines.push(`  - ${limitation}`)
  return lines.join("\n")
}

/**
 * The composition both server boundaries (the dev-server AgentApi via CloudAgent
 * and the deployed product Worker) apply before calling the upstream chat
 * service: instructions plus the rendered context block. Upstream sees one
 * instructions string; the structured context itself never crosses to it.
 */
export const composeAgentInstructions = (
  instructions: string,
  context?: AgentRuntimeContext
): string => context === undefined ? instructions : `${instructions}\n\n${renderAgentRuntimeContext(context)}`

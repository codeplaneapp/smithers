/**
 * Invocation-scoped presentation: handlers return data, this adapter owns UX.
 * Async-local context keeps concurrent MCP requests from sharing UI state.
 * @since 1.0.0
 */
import * as clack from "@clack/prompts"
import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import * as Redaction from "@smthrs/journal/Redaction"
import { AsyncLocalStorage } from "node:async_hooks"
import { Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"

interface Session {
  readonly transport: "mcp" | "cli"
  readonly policy: Audience.Policy
  readonly command: string
  readonly stdout: Writable
  readonly stderr: Writable
}
const sessions = new AsyncLocalStorage<Session>()
const stream = (terminal: RuntimeConfig["stdout"], fallback: Writable): Writable =>
  terminal === undefined ?
    fallback :
    new Writable({
      write(chunk, _encoding, done) {
        terminal.write(String(chunk))
        done()
      }
    })

/**
 * Presentation inputs supplied by Incur without exposing its implementation internals.
 * @category models
 * @since 1.0.0
 */
export interface Context {
  readonly command?: string | undefined
  readonly agent?: boolean | undefined
  readonly formatExplicit?: boolean | undefined
  readonly request?: unknown
  readonly globals?: { readonly audience?: Audience.Mode; readonly silent?: boolean } | undefined
  readonly args?: Readonly<Record<string, unknown>> | undefined
  readonly options?: Readonly<Record<string, unknown>> | undefined
  readonly ok?:
    | ((data: unknown, meta?: { cta?: { commands: Array<{ command: string; description: string }> } }) => never)
    | undefined
}

/**
 * Resolve once per invocation. No streams or environment values are mutated.
 * @category selection
 * @since 1.0.0
 */
export const policy = (context: Context, runtime: RuntimeConfig = {}): Audience.Policy => {
  const base = runtime.presentation
  const protocol = isMcp(context, runtime)
  return Audience.resolve({
    env: runtime.environment,
    stdout: runtime.stdout?.isTTY,
    stderr: runtime.stderr?.isTTY,
    audience: context.globals?.audience !== undefined && context.globals.audience !== "auto"
      ? context.globals.audience :
      base?.audience,
    mcp: protocol,
    formatExplicit: base?.structured === true || context.formatExplicit,
    silent: context.globals?.silent === true || base?.progress === "silent",
    verbose: base?.audience === "agent" && base.progress === "plain"
  })
}

/**
 * Keep one command's rendering preferences out of every handler's business logic.
 * @category constructors
 * @since 1.0.0
 */
export const scope = (context: Context, runtime: RuntimeConfig, next: () => Promise<void>): Promise<void> => {
  const resolved = policy(context, runtime)
  return sessions.run({
    transport: isMcp(context, runtime) ? "mcp" : "cli",
    policy: resolved,
    command: resolved.source === "mcp" ? (context.command ?? "").replaceAll("_", " ") : context.command ?? "",
    stdout: stream(runtime.stdout, process.stdout),
    stderr: stream(runtime.stderr, process.stderr)
  }, next)
}

/**
 * Current invocation, absent for direct library calls.
 * @category getters
 * @since 1.0.0
 */
export const current = (): Session | undefined => sessions.getStore()

// Host/protocol inputs, not the user-selectable audience. Incur's stdio MCP
// context has agent + explicit format + no CLI globals; HTTP has a request.
const isMcp = (context: Context, runtime: RuntimeConfig): boolean =>
  runtime.presentation?.source === "mcp" || context.request !== undefined ||
  (context.agent === true && context.formatExplicit === true && Object.keys(context.globals ?? {}).length === 0)

const quote = (value: string) => /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Contextual, bounded next actions. Never echo credentials or approval payloads.
 * @category constructors
 * @since 1.0.0
 */
export const nextActions = (command: string, value: unknown, context: Context = {}) => {
  const data = record(value)
  const args = context.args ?? {}
  const options = context.options ?? {}
  const root = text(options["root"])
  const remote = text(options["remote"])
  let connection = root === undefined ? "" : ` --root ${quote(root)}`
  if (remote !== undefined) {
    try {
      const url = new URL(remote)
      if (!url.username && !url.password && !url.search && !url.hash) connection += ` --remote ${quote(remote)}`
    } catch { /* Malformed connection arguments are handled before execution. */ }
  }
  const actions: Array<{ command: string; description: string }> = []
  const add = (action: string, description: string) => actions.push({ command: action + connection, description })
  const runId = text(data["runId"]) ?? text(args["run"])
  if (runId !== undefined) {
    if (command !== "runs show") add(`runs show ${quote(runId)}`, "Inspect status and the reason execution stopped")
    add(`runs logs ${quote(runId)} --format jsonl`, "Read detailed events only when needed")
    if (data["status"] === "waiting-approval" || data["_tag"] === "Parked") {
      add("approvals list", "Inspect pending approval payloads")
    }
  } else if (command === "flow list") {
    const first = Array.isArray(data["items"]) ? record(data["items"][0]) : {}
    const flowId = text(first["flowId"])
    if (flowId !== undefined) add(`flow show ${quote(flowId)}`, "Inspect a discovered flow")
    add("flow plan --help", "See how to preview a flow before starting it")
  } else if (command === "flow plan") {
    add("approvals approve --help", "Approve the returned plan.approval payload or an @file")
    add("flow execute --help", "Execute that same payload after approval")
  } else if (command.startsWith("runs")) add("runs list", "List the current durable run records")
  else if (command === "init" || command.startsWith("generate")) {
    add("targets", "Inspect available workspace targets")
    add("flow list", "Inspect discovered workflows")
  } else if (command.startsWith("triggers")) {
    add("triggers list", "Inspect schedules and active launches")
    add("triggers show --help", "Inspect the exact approval card for a scheduled launch")
  } else if (command.startsWith("approvals")) add("runs list", "Check the run after the decision")
  else if (command === "doctor") add("info", "Inspect workspace and host configuration")
  else if (command.startsWith("credentials")) {
    add("credentials list", "Inspect credential metadata without revealing secrets")
  } else if (command.startsWith("eval")) add("eval compare --help", "Compare results with a baseline")
  else if (command.startsWith("memory")) add("memory recall --help", "Recall relevant stored context")
  else if (command.startsWith("integrations")) add("integrations list", "Inspect configured integrations")
  return actions.slice(0, 3)
}

const clean = (value: unknown): string =>
  stripVTControlCharacters(String(Redaction.redact(value))).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(
    0,
    500
  )
const linesOf = (value: unknown, indent = "", depth = 0): Array<string> => {
  if (value === undefined) return []
  if (value === null || typeof value !== "object") return [indent + clean(value)]
  if (depth >= 3) return [indent + (Array.isArray(value) ? `${value.length} items` : "Use --json for full details")]
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index + 1), entry] as const)
    : Object.entries(value)
  const lines = entries.slice(0, 18).flatMap(([key, item]) => {
    if (Array.isArray(item) && item.length === 0) return [`${indent}${clean(key)}: none`]
    if (item !== null && typeof item === "object") {
      return [`${indent}${clean(key)}`, ...linesOf(item, `${indent}  `, depth + 1)]
    }
    return [`${indent}${clean(key)}: ${clean(item)}`]
  })
  if (entries.length > 18) lines.push(`${indent}… ${entries.length - 18} more; use --json for full details`)
  return lines
}

/**
 * How a handler wants its result shown to a person. Agents and explicit
 * formats never see it: the returned document stays the contract.
 * @category models
 * @since 1.0.0
 */
export interface Rendering {
  /**
   * A body already written for a person, printed in place of the generic
   * key/value summary. The command title and the Next actions still frame it.
   */
  readonly human?: string | undefined
}

/**
 * Preserve data for agents; render a bounded Clack result for humans.
 * Explicit JSON/format always keeps the original machine-readable document.
 * @category formatting
 * @since 1.0.0
 */
export const finish = <A>(context: Context, value: A, rendering: Rendering = {}): A => {
  const session = current()
  if (session === undefined || context.ok === undefined || value === undefined) return value
  const actions = nextActions(session.command, value, context)
  if (session.policy.structured) {
    // Incur merges CTA fields into arrays as numeric object keys. Preserve
    // existing array result contracts rather than changing their shape.
    return actions.length === 0 || Array.isArray(value) ? value : context.ok(value, { cta: { commands: actions } })
  }
  const summary = rendering.human === undefined
    ? linesOf(Redaction.redact(value)).slice(0, 80).join("\n") || "Done"
    : rendering.human.trimEnd()
  if (session.policy.progress === "live") clack.note(summary, session.command, { output: session.stdout })
  else session.stdout.write(`${session.command}\n${summary}\n`)
  if (actions.length > 0) {
    const next = actions.map((action) => `smthrs ${action.command}`).join("\n")
    if (session.policy.progress === "live") clack.log.info(`Next:\n${next}`, { output: session.stdout })
    else session.stdout.write(`Next:\n${next}\n`)
  }
  return context.ok(undefined)
}

/**
 * Read-only forensic projections of a run's journal events.
 *
 * The vault's Forensics concept fixes the CLI surface at exactly two
 * projections: `flows logs` projects journal queries and `flows status`
 * projects the run summary and its gating cause. This module is the rendering
 * half of both — pure functions from the `ControlEvent` deltas that
 * `Control.watch` already serves, to a turn-by-turn transcript, a one-line
 * follow view, and the status card's diagnosis. Nothing here opens a
 * database; the control plane stays the only read path, so `--remote` renders
 * exactly what a local run renders.
 *
 * The need is concrete: the first SWE-bench benchmark of the built-in harness
 * was diagnosed with ad-hoc SQLite scripts because a settled run's journal
 * had no readable projection. Every question those scripts answered — where
 * the turns went, which calls were refused and why, whether an edit was ever
 * attempted, what the run died of — is computed here from the events alone.
 *
 * @since 0.1.0
 */
import type { ControlSchema } from "@smthrs/control"

/**
 * One refused flow call, aggregated by its refusal message.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Refusal {
  readonly message: string
  readonly count: number
}

/**
 * Everything the diagnosis computes from one run's events.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Digest {
  /** The last `control.run.*` transition seen, or undefined before launch. */
  readonly status: string | undefined
  /** The journaled failure cause, when the run failed and recorded one. */
  readonly cause: string | undefined
  readonly seat: string | undefined
  readonly turns: number
  readonly calls: number
  readonly callsFailed: number
  /** Calls whose flow and input were byte-identical to an earlier call. */
  readonly duplicateCalls: number
  readonly editsAttempted: number
  readonly editsSucceeded: number
  /** Call counts by flow name, descending. */
  readonly flows: ReadonlyArray<readonly [string, number]>
  /** Refusal messages, descending by count. */
  readonly refusals: ReadonlyArray<Refusal>
  readonly inputTokens: number
  readonly outputTokens: number
  /** The final assistant output, when the run resolved. */
  readonly finalOutput: string | undefined
  /** The pending ask's question, when the run parked for approval. */
  readonly parkedQuestion: string | undefined
  /** The serialized approval payload that unblocks a parked run. */
  readonly parkedApproval: string | undefined
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
}

/** Flows whose calls count as edit attempts. */
const editFlows: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"])

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const asNumber = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

/** Occurrence time: the payload's own stamp, else journal admission time. */
const timeOf = (event: ControlSchema.ControlEvent): number => asNumber(asRecord(event.payload).at) ?? event.occurredAt

const firstLine = (text: string): string => {
  const index = text.indexOf("\n")
  return index < 0 ? text : text.slice(0, index)
}

const clip = (text: string, width: number): string => text.length <= width ? text : `${text.slice(0, width - 1)}…`

const compact = (value: unknown, width: number): string => {
  const rendered = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  return clip(firstLine(rendered), width)
}

/**
 * Computes the diagnosis for one run from its ordered events.
 *
 * Total on purpose: payloads are wire `Json`, so every field read tolerates
 * absence and the digest of a malformed journal is a sparse digest, never a
 * throw.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const digest = (events: ReadonlyArray<ControlSchema.ControlEvent>): Digest => {
  let status: string | undefined
  let cause: string | undefined
  let seat: string | undefined
  let turns = 0
  let calls = 0
  let callsFailed = 0
  let duplicateCalls = 0
  let editsAttempted = 0
  let editsSucceeded = 0
  let inputTokens = 0
  let outputTokens = 0
  let finalOutput: string | undefined
  let parkedQuestion: string | undefined
  let parkedApproval: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  const flowCounts = new Map<string, number>()
  const refusalCounts = new Map<string, number>()
  const seen = new Map<string, number>()

  for (const event of events) {
    const payload = asRecord(event.payload)
    const at = timeOf(event)
    startedAt = startedAt === undefined ? at : Math.min(startedAt, at)
    endedAt = endedAt === undefined ? at : Math.max(endedAt, at)
    switch (event.kind) {
      case "control.agent.turn-opened": {
        turns += 1
        seat = asString(payload.seat) ?? seat
        break
      }
      case "control.agent.model-settled": {
        const usage = asRecord(payload.usage)
        inputTokens += asNumber(usage.inputTokens) ?? 0
        outputTokens += asNumber(usage.outputTokens) ?? 0
        break
      }
      case "control.agent.cell-call-started": {
        calls += 1
        const flowName = asString(payload.flowName) ?? "?"
        flowCounts.set(flowName, (flowCounts.get(flowName) ?? 0) + 1)
        if (editFlows.has(flowName)) editsAttempted += 1
        const identity = `${flowName}\u0000${JSON.stringify(payload.input) ?? ""}`
        const previous = seen.get(identity) ?? 0
        if (previous > 0) duplicateCalls += 1
        seen.set(identity, previous + 1)
        break
      }
      case "control.agent.cell-call-settled": {
        if (asString(payload.outcome) === "failure") {
          callsFailed += 1
          const message = firstLine(asString(payload.message) ?? "unknown refusal")
          refusalCounts.set(message, (refusalCounts.get(message) ?? 0) + 1)
        } else if (editFlows.has(asString(payload.flowName) ?? "")) {
          editsSucceeded += 1
        }
        break
      }
      case "control.agent.resolved": {
        finalOutput = asString(payload.text)
        break
      }
      case "control.approval.requested": {
        parkedQuestion = asString(payload.question)
        const approval = payload.payload
        parkedApproval = approval === undefined ? undefined : JSON.stringify(approval)
        break
      }
      default: {
        if (event.kind.startsWith("control.run.")) {
          status = event.kind.slice("control.run.".length)
          if (status === "failed") cause = asString(payload.cause)
        }
      }
    }
  }

  return {
    status,
    cause,
    seat,
    turns,
    calls,
    callsFailed,
    duplicateCalls,
    editsAttempted,
    editsSucceeded,
    flows: [...flowCounts.entries()].sort((left, right) => right[1] - left[1]),
    refusals: [...refusalCounts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((left, right) => right.count - left.count),
    inputTokens,
    outputTokens,
    finalOutput,
    parkedQuestion,
    parkedApproval,
    startedAt,
    endedAt
  }
}

const duration = (d: Digest): string => {
  if (d.startedAt === undefined || d.endedAt === undefined) return "0s"
  const seconds = Math.max(0, Math.round((d.endedAt - d.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

/**
 * The one-line verdict: the status plus the reason that most explains it.
 *
 * Priority order mirrors what a reader needs first: a recorded failure cause,
 * then a park's question, then the "worked but never edited" pathology that a
 * green status would otherwise hide, then the resolved output.
 */
const verdict = (d: Digest): string => {
  const status = d.status ?? "unlaunched"
  if (status === "failed") {
    return d.cause === undefined
      ? "failed — no cause recorded in the journal"
      : `failed — ${clip(firstLine(d.cause), 100)}`
  }
  if (status === "waiting-approval") {
    return d.parkedQuestion === undefined
      ? "waiting-approval — a permission gate is pending"
      : `waiting-approval — asks: ${clip(d.parkedQuestion, 90)}`
  }
  if (status === "completed" && d.calls > 0 && d.editsAttempted === 0) {
    return `completed — but 0 of ${d.calls} calls attempted an edit; the run only read`
  }
  if (status === "completed" && d.finalOutput !== undefined && d.finalOutput.length > 0) {
    return `completed — ${clip(firstLine(d.finalOutput), 100)}`
  }
  return status
}

const label = (name: string): string => name.padEnd(10)

/**
 * Renders the status card for one run: verdict, gating cause, activity
 * evidence, and the exact next commands.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const renderDiagnosis = (
  run: { readonly runId?: string; readonly flowId?: string } | undefined,
  d: Digest
): string => {
  const lines: Array<string> = []
  const runId = run?.runId ?? "?"
  lines.push(`${label("Verdict")}${verdict(d)}`)
  lines.push(
    `${label("Run")}${runId}${run?.flowId === undefined ? "" : ` · ${run.flowId}`}${
      d.seat === undefined ? "" : ` · ${d.seat}`
    } · ${duration(d)}`
  )
  lines.push(
    `${
      label("Activity")
    }${d.turns} turns · ${d.calls} calls (${d.callsFailed} refused, ${d.duplicateCalls} duplicate) · edits ${d.editsSucceeded}/${d.editsAttempted}`
  )
  lines.push(
    `${label("Tokens")}${d.inputTokens.toLocaleString("en-US")} in / ${d.outputTokens.toLocaleString("en-US")} out`
  )
  for (const [index, refusal] of d.refusals.slice(0, 3).entries()) {
    lines.push(`${label(index === 0 ? "Refusals" : "")}${refusal.count}× ${clip(refusal.message, 110)}`)
  }
  if (d.cause !== undefined) {
    lines.push(`${label("Cause")}${clip(firstLine(d.cause), 120)}`)
  }
  if (d.finalOutput !== undefined && d.finalOutput.length > 0) {
    lines.push(`${label("Output")}${clip(firstLine(d.finalOutput), 120)}`)
  }
  if (d.parkedApproval !== undefined) {
    lines.push(`${label("Unblock")}flows approve '${d.parkedApproval}' --scope run && flows run --resume ${runId}`)
  }
  lines.push(`${label("Next")}flows logs ${runId}    # turn-by-turn transcript`)
  return lines.join("\n")
}

const offset = (at: number, start: number): string => {
  const seconds = Math.max(0, Math.round((at - start) / 1000))
  return `+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

/**
 * Renders one event as a single follow-mode line.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const eventLine = (event: ControlSchema.ControlEvent): string => {
  const payload = asRecord(event.payload)
  switch (event.kind) {
    case "control.agent.turn-opened":
      return `turn opened · ${asString(payload.seat) ?? ""}`
    case "control.agent.model-settled": {
      const usage = asRecord(payload.usage)
      return `model   ${compact(asString(payload.text) ?? "", 100)} (${asNumber(usage.inputTokens) ?? 0} in / ${
        asNumber(usage.outputTokens) ?? 0
      } out)`
    }
    case "control.agent.cell-produced":
      return `cell    ${compact(asString(payload.text) ?? "", 100)}`
    // The realm's whole channel to the next model turn. It used to be the
    // transition's `context`, which the `continue` line below reported in
    // bytes; that field left with the filing surface, and this is what
    // replaced it, so the reader is shown the same fact from where it now
    // lives.
    case "control.agent.cell-printed":
      return `print   ${compact(asString(payload.text) ?? "", 100)}`
    case "control.agent.cell-call-started":
      return `call    ${asString(payload.flowName) ?? "?"} ${compact(payload.input, 90)}`
    case "control.agent.cell-call-settled":
      return asString(payload.outcome) === "failure"
        ? `  -> FAIL ${compact(asString(payload.message) ?? "", 100)}`
        : `  -> ok ${compact(payload.value, 90)}`
    case "control.agent.transition-applied": {
      const transition = asRecord(payload.transition)
      const tag = asString(transition._tag) ?? "?"
      const justification = asString(transition.justification)
      // Only where the journal actually carries them, so a current run's line
      // is not two constants and a wave that filed is still read in full.
      const filed = [
        transition.state === undefined || transition.state === null
          ? undefined
          : `state ${JSON.stringify(transition.state).length}B`,
        Array.isArray(transition.context) && transition.context.length > 0
          ? `context ${JSON.stringify(transition.context).length}B`
          : undefined
      ].filter((part) => part !== undefined).join(" · ")
      return tag === "complete"
        ? `complete ${compact(asString(transition.output) ?? "", 90)}`
        : tag === "park"
        ? `park (${asString(transition.reason) ?? "?"}) ${compact(asString(transition.message) ?? "", 80)}`
        // `context` and `state` were the filing surface's two slots, and this
        // line used to report their byte sizes. Nothing populates either since
        // 2026-08-24, so reading them off a current run prints two constants;
        // journals from the r90–r96 waves still carry them, and those are the
        // only runs the byte counts are read for.
        : `continue${justification === undefined ? "" : ` · ${compact(justification, 90)}`}${
          filed === "" ? "" : ` · filed ${filed}`
        }`
    }
    case "control.agent.cell-settled": {
      const outcome = asRecord(payload.outcome)
      const tag = asString(outcome._tag) ?? "?"
      return tag === "settled"
        ? "cell settled"
        : `cell ${tag.toUpperCase()} ${compact(asString(outcome.message) ?? "", 90)}`
    }
    default:
      return `${event.kind} ${compact(event.payload, 80)}`
  }
}

/**
 * Renders the whole run as a turn-by-turn transcript.
 *
 * One `=== turn N ===` header per model turn; one line per event under it,
 * offset-stamped from the run's first event. Refusals and errors keep their
 * message; successful payloads are compressed to a line, because the reader
 * scanning for "where did it go wrong" needs the shape of the run, not the
 * bytes of every result.
 *
 * @category rendering
 * @since 0.1.0
 * @slop
 */
export const renderTranscript = (events: ReadonlyArray<ControlSchema.ControlEvent>): string => {
  if (events.length === 0) return "No events."
  const d = digest(events)
  const start = d.startedAt ?? 0
  const runId = events.find((event) => event.runId !== undefined)?.runId
  const lines: Array<string> = [
    `${runId ?? "?"} · ${d.status ?? "?"} · ${
      duration(d)
    } · ${d.turns} turns · ${d.calls} calls (${d.callsFailed} refused) · ${
      d.inputTokens.toLocaleString("en-US")
    } in / ${d.outputTokens.toLocaleString("en-US")} out tok`
  ]
  let turn = 0
  for (const event of events) {
    if (event.kind === "control.agent.turn-opened") {
      turn += 1
      lines.push("", `=== turn ${turn} · ${asString(asRecord(event.payload).seat) ?? ""} ===`)
      continue
    }
    if (!event.kind.startsWith("control.agent.")) {
      if (event.kind.startsWith("control.run.") || event.kind === "control.approval.requested") {
        lines.push(`[${offset(timeOf(event), start)}] ${event.kind.slice("control.".length)}`)
      }
      continue
    }
    if (event.kind === "control.agent.turn-closed" || event.kind === "control.agent.steering-drained") continue
    lines.push(`[${offset(timeOf(event), start)}] ${eventLine(event)}`)
  }
  return lines.join("\n")
}

/**
 * Durable flow, run, and approval commands for the unified CLI.
 * @since 1.0.0
 */
import { Control, type ControlSchema } from "@smthrs/control"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Redaction from "@smthrs/journal/Redaction"
import { Effect } from "effect"
import { Cli, z } from "incur"
import { readFile } from "node:fs/promises"
import * as Forensics from "../Forensics.ts"
import * as Failure from "../internal/Failure.ts"
import * as FeaturedFlows from "../internal/FeaturedFlows.ts"
import * as History from "../internal/History.ts"
import * as Bridge from "./ControlBridge.ts"
import { prepareHistoryRun, reconcileHistory } from "./HistoryCommands.ts"
import * as Presentation from "./Presentation.ts"
import * as RunProgress from "./RunProgress.ts"

const options = Bridge.connectionOptions
const runArgs = z.object({ run: z.string().min(1).describe("Durable run ID") })
const flowArgs = z.object({ flow: z.string().min(1).describe("Discovered flow name") })
const statuses = ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"] as const

interface ErrorContext extends Presentation.Context {
  readonly error: (error: { code: string; message: string; exitCode?: number }) => never
}

/**
 * Gives typed backend errors a stable, redacted CLI rendering.
 * @category constructors
 * @since 1.0.0
 */
export const safe = async <A>(
  context: ErrorContext,
  body: () => Promise<A>,
  rendering: (value: A) => Presentation.Rendering = () => ({})
): Promise<A> => {
  try {
    const value = await body()
    return Presentation.finish(context, value, rendering(value))
  } catch (cause) {
    const error = cause as { _tag?: string; message?: string }
    return context.error({
      code: NodeDatabase.isUnsupportedDatabase(cause) ? cause.code : error?._tag?.split("/").pop() ?? "command_failed",
      message: String(
        Redaction.redact(cause instanceof Error ? Failure.sentence(cause) : error?.message ?? String(cause))
      ),
      exitCode: error?._tag === "/cli/UsageError" ? 2 : 1
    })
  }
}

const dataArgs = (data: string | undefined) => data === undefined ? [] : ["--data", data]

/**
 * The flow catalog and explicit plan/start lifecycle.
 * @category constructors
 * @since 1.0.0
 */
export const createFlowCli = (runtime: Bridge.Runtime = {}) =>
  Cli.create("flow", {
    description: "Discover, plan, and start durable workflows"
  })
    .command("list", {
      description: "List project flows",
      options,
      run: (c) =>
        safe(
          c,
          () => Bridge.invoke(["ls"], c.options, runtime),
          // A person reads one line per flow, featured rows starred, so the
          // recommended set is visible without a table, then the same Next
          // actions every listing offers. Agents and `--json` keep the flow
          // page document unchanged.
          (page) => FeaturedFlows.isFlowPage(page) ? { human: FeaturedFlows.human(page.items) } : {}
        )
    })
    .command("show", {
      description: "Show a discovered flow's identity and description",
      args: flowArgs,
      options,
      run: (c) =>
        safe(c, () =>
          Bridge.query(
            Effect.gen(function*() {
              const control = yield* Control.Control
              let cursor: string | undefined
              do {
                const page = yield* control.list({ _tag: "flows", ...(cursor === undefined ? {} : { cursor }) })
                if (page._tag !== "flows") throw new Error("Expected a flow catalog")
                const flow = page.items.find((entry) => entry.flowId === c.args.flow)
                if (flow !== undefined) return flow
                cursor = page.nextCursor
              } while (cursor !== undefined)
              throw new Error(`Unknown flow ${c.args.flow}`)
            }),
            c.options,
            runtime
          ))
    })
    .command("plan", {
      description: "Compile a flow plan and its approval payload without executing it",
      args: flowArgs.extend({ input: z.array(z.string()).default([]).describe("Input fields as key=value") }),
      options: options.extend({ data: z.string().optional().describe("JSON input object") }),
      run: (c) =>
        safe(c, () =>
          Bridge.invoke(["plan", c.args.flow, ...c.args.input, ...dataArgs(c.options.data)], c.options, runtime))
    })
    .command("start", {
      description: "Plan, approve, and start one flow; optionally detach after durable admission",
      mcp: false,
      args: flowArgs,
      options: options.extend({ data: z.string().optional(), detached: z.boolean().default(false) }),
      alias: { detached: "d" },
      run: (c) =>
        safe(c, () =>
          Bridge.invoke(
            ["up", c.args.flow, ...dataArgs(c.options.data), ...(c.options.detached ? ["--detached"] : [])],
            c.options,
            runtime
          ))
    })
    .command("execute", {
      description: "Execute a previously approved plan payload",
      args: z.object({ approval: z.string().describe("Serialized payload or @file") }),
      options,
      run: (c) =>
        safe(c, async () => Bridge.invoke(["run", await payload(c.args.approval)], c.options, runtime))
    })

/**
 * Canonical commands for existing durable run records.
 * @category constructors
 * @since 1.0.0
 */
export const createRunsCli = (runtime: Bridge.Runtime = {}) =>
  Cli.create("runs", {
    description: "Inspect and control durable execution records"
  })
    .command("list", {
      description: "List durable runs filtered by flow or status",
      options: options.extend({ flow: z.string().optional(), status: z.enum(statuses).optional() }),
      run: (c) =>
        safe(c, () => {
          reconcileHistory(c.options, runtime)
          return Bridge.invoke(
            [
              "ps",
              ...(c.options.flow ? ["--flow", c.options.flow] : []),
              ...(c.options.status ? ["--status", c.options.status] : [])
            ],
            c.options,
            runtime
          )
        })
    })
    .command("show", {
      description: "Show a run's current status and diagnosis",
      args: runArgs,
      options,
      run: (c) =>
        safe(c, () => {
          reconcileHistory(c.options, runtime)
          return Bridge.query(
            Effect.gen(function*() {
              const control = yield* Control.Control
              const page = yield* control.list({ _tag: "runs", filters: { runId: c.args.run } })
              const run = page._tag === "runs" ? page.items.find((row) => row.runId === c.args.run) : undefined
              if (run === undefined) throw new Error(`Unknown run ${c.args.run}`)
              const events = yield* History.collect(control.watch({ runId: run.runId, follow: false }), {
                operation: "run diagnosis",
                subject: run.runId
              })
              return { ...run, diagnosis: Forensics.digest(events) }
            }),
            c.options,
            runtime
          )
        })
    })
    .command("logs", {
      description: "Read run events or follow new events as they commit",
      args: runArgs,
      options: options.extend({
        follow: z.boolean().default(false),
        after: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(10000).optional().describe(
          "Maximum events; agent history pulls default to 100"
        )
      }),
      async *run(c) {
        const policy = Presentation.current()?.policy ?? Presentation.policy(c, runtime)
        const limit = c.options.limit ??
          (policy.audience === "agent" && !c.options.follow ? 100 : Number.POSITIVE_INFINITY)
        const renderer = policy.structured ? undefined : RunProgress.make(c.args.run, {
          policy: { ...policy, progress: policy.progress === "silent" ? "plain" : policy.progress },
          output: Presentation.current()?.stdout ?? process.stdout
        })
        let count = 0
        let after = c.options.after
        try {
          for await (
            const event of Bridge.events(c.args.run, c.options.follow, c.options, runtime, c.options.after)
          ) {
            after = event.sequence
            count++
            if (renderer === undefined) yield event
            else renderer.event(event)
            if (count >= limit) break
          }
          if (renderer === undefined && after !== undefined && count >= limit) {
            const more = Presentation.nextActions("runs show", { runId: c.args.run }, c)[0]!
            return c.ok({ events: count, after }, {
              cta: {
                commands: [{
                  command: more.command.replace(" --format jsonl", ` --after ${after} --format jsonl`),
                  description: "Continue from the last returned event"
                }]
              }
            })
          }
        } catch (cause) {
          renderer?.close("failed")
          return c.error({
            code: "logs_failed",
            message: String(Redaction.redact(cause instanceof Error ? cause.message : String(cause)))
          })
        } finally {
          renderer?.close("ended")
        }
      }
    })
    .command("output", {
      description: "Read recorded outputs for one node or all nodes",
      args: runArgs.extend({ node: z.string().optional() }),
      options,
      run: (c) =>
        safe(c, () => Bridge.invoke(["output", c.args.run, ...(c.args.node ? [c.args.node] : [])], c.options, runtime))
    })
    .command("cancel", {
      description: "Cancel one durable run",
      args: runArgs,
      options,
      run: (c) => safe(c, () => Bridge.invoke(["cancel", c.args.run], c.options, runtime))
    })
    .command("cancel-all", {
      description: "Cancel every nonterminal run in this project",
      options,
      destructive: true,
      run: (c) =>
        safe(c, async () => {
          reconcileHistory(c.options, runtime)
          const runs = await Bridge.query(
            Effect.gen(function*() {
              const control = yield* Control.Control
              const ids: Array<string> = []
              let cursor: string | undefined
              do {
                const page = yield* control.list({ _tag: "runs", ...(cursor === undefined ? {} : { cursor }) })
                if (page._tag !== "runs") throw new Error("Expected durable runs")
                ids.push(
                  ...page.items.filter((run) => !["completed", "failed", "cancelled"].includes(run.status)).map((run) =>
                    run.runId
                  )
                )
                cursor = page.nextCursor
              } while (cursor !== undefined)
              return ids
            }),
            c.options,
            runtime
          )
          const cancelled = []
          for (const runId of runs) {
            cancelled.push({ runId, receipt: await Bridge.invoke(["cancel", runId], c.options, runtime) })
          }
          return { cancelled }
        })
    })
    .command("resume", {
      description: "Resume a parked durable run",
      args: runArgs,
      options,
      run: (c) =>
        safe(c, () =>
          Bridge.invoke(["resume", c.args.run], c.options, {
            ...runtime,
            ...prepareHistoryRun(c.args.run, c.options, runtime)
          }))
    })
    .command("signal", {
      description: "Deliver a durable JSON signal",
      args: runArgs.extend({ payload: z.string() }),
      options,
      run: (c) => safe(c, () => Bridge.invoke(["signal", c.args.run, c.args.payload], c.options, runtime))
    })
    .command("steer", {
      description: "Send an attributed operator message",
      args: runArgs,
      options: options.extend({ message: z.string().min(1) }),
      run: (c) =>
        safe(c, () => Bridge.invoke(["steer", c.args.run, "--message", c.options.message], c.options, runtime))
    })

const payload = async (value: string): Promise<string> =>
  value.startsWith("@") ? readFile(value.slice(1), "utf8") : value

/**
 * Pending in-run approvals, including pages beyond the first.
 * @category constructors
 * @since 1.0.0
 */
export const pendingApprovals = (runId?: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const runs: Array<ControlSchema.RunSummary> = []
    let cursor: string | undefined
    do {
      const page = yield* control.list({
        _tag: "runs",
        filters: { status: "waiting-approval", ...(runId ? { runId } : {}) },
        ...(cursor ? { cursor } : {})
      })
      if (page._tag !== "runs") throw new Error("Expected durable runs")
      runs.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return yield* Effect.forEach(runs, (run) =>
      Effect.gen(function*() {
        const events = yield* History.collect(control.watch({ runId: run.runId, follow: false }), {
          operation: "pending approval",
          subject: run.runId
        })
        const digest = Forensics.digest(events)
        return {
          runId: run.runId,
          flowId: run.flowId,
          question: digest.parkedQuestion,
          approval: digest.parkedApproval
        }
      }))
  })

/**
 * Pending decisions and approval payload submission.
 * @category constructors
 * @since 1.0.0
 */
export const createApprovalsCli = (runtime: Bridge.Runtime = {}) =>
  Cli.create("approvals", { description: "Find and resolve pending approval requests" })
    .command("list", {
      description: "List pending in-run approvals with their exact authorization payloads",
      options: options.extend({ run: z.string().optional() }),
      run: (c) => safe(c, () => Bridge.query(pendingApprovals(c.options.run), c.options, runtime))
    })
    .command("approve", {
      description: "Approve the exact serialized payload or @file",
      mcp: false,
      args: z.object({ approval: z.string() }),
      options: options.extend({ scope: z.enum(["once", "run", "remembered"]).default("once") }),
      run: (c) =>
        safe(
          c,
          async () =>
            Bridge.invoke(["approve", await payload(c.args.approval), "--scope", c.options.scope], c.options, runtime)
        )
    })
    .command("deny", {
      description: "Deny the exact serialized payload or @file",
      mcp: false,
      args: z.object({ approval: z.string() }),
      options,
      run: (c) => safe(c, async () => Bridge.invoke(["deny", await payload(c.args.approval)], c.options, runtime))
    })

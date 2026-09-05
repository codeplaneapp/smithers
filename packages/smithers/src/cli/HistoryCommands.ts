/**
 * Time-travel commands mounted on the durable runs namespace.
 * @since 1.0.0
 */
import * as Redaction from "@smthrs/journal/Redaction"
import { type Cli, z } from "incur"
import * as Environment from "../Environment.ts"
import * as History from "../history/History.ts"
import * as Bridge from "./ControlBridge.ts"
import * as Presentation from "./Presentation.ts"

const args = z.object({ run: z.string().min(1).describe("Durable run ID") })
const options = Bridge.connectionOptions.extend({
  at: z.number().int().nonnegative().optional().describe("Journal sequence to inspect; defaults to the latest frame"),
  lineage: z.string().optional().describe("Lineage ID; defaults to the lineage recorded at the frame"),
  limit: z.number().int().positive().default(10_000).describe("Maximum journal entries to read")
})
const mutationOptions = options.extend({
  at: z.number().int().nonnegative().describe("Exact journal sequence to branch or rewind to")
})
const parameters = (parsed: z.output<typeof options>): History.Options => ({ ...parsed, sequence: parsed.at })
const failed = (
  c: { readonly error: (value: { code: string; message: string; exitCode?: number }) => never },
  cause: unknown
): never =>
  c.error({
    code: "history_failed",
    message: String(Redaction.redact(cause instanceof Error ? cause.message : String(cause))),
    exitCode: 1
  })

/**
 * Mount the read and mutation commands on an existing runs group.
 * @since 1.0.0
 * @category constructors
 */
export const appendHistoryCommands = (cli: Cli.Cli, runtime: Bridge.Runtime = {}) =>
  cli
    .command("inspect", {
      description: "Inspect the state and event counts recorded at one historical frame",
      args,
      options,
      async run(c) {
        try {
          return Presentation.finish(
            c,
            await History.read(
              History.localRoot(c.options, runtime.environment ?? process.env),
              c.args.run,
              parameters(c.options),
              false,
              runtime.signal
            )
          )
        } catch (cause) {
          return failed(c, cause)
        }
      }
    })
    .command("replay", {
      description: "Replay committed history and sealed results without re-executing any actions",
      args,
      options,
      async run(c) {
        try {
          return Presentation.finish(
            c,
            await History.read(
              History.localRoot(c.options, runtime.environment ?? process.env),
              c.args.run,
              parameters(c.options),
              true,
              runtime.signal
            )
          )
        } catch (cause) {
          return failed(c, cause)
        }
      }
    })
    .command("fork", {
      description: "Branch a parked run at a historical frame into a durable, isolated workspace",
      args,
      options: mutationOptions,
      async run(c) {
        try {
          return Presentation.finish(
            c,
            await History.mutate(
              History.localRoot(c.options, runtime.environment ?? process.env),
              c.args.run,
              parameters(c.options),
              "fork",
              runtime.signal
            )
          )
        } catch (cause) {
          return failed(c, cause)
        }
      }
    })
    .command("rewind", {
      description: "Preview or archive a run's suffix and restore an earlier frame; requires --yes to mutate",
      args,
      options: mutationOptions.extend({
        preview: z.boolean().default(false).describe("Show the affected suffix and effects without changing anything"),
        yes: z.boolean().default(false).describe("Confirm archiving the suffix and restoring the historical frame")
      }),
      destructive: true,
      async run(c) {
        if (!c.options.preview && !c.options.yes) {
          return c.error({
            code: "confirmation_required",
            exitCode: 2,
            message: "Use --preview to inspect the rewind, then --yes to apply it"
          })
        }
        try {
          const root = History.localRoot(c.options, runtime.environment ?? process.env)
          if (c.options.preview) {
            return Presentation.finish(
              c,
              await History.preview(root, c.args.run, parameters(c.options), runtime.signal)
            )
          }
          return Presentation.finish(
            c,
            await History.mutate(root, c.args.run, parameters(c.options), "rewind", runtime.signal)
          )
        } catch (cause) {
          return failed(c, cause)
        }
      }
    })

/**
 * Reconciles local history before a normal runs list/show query.
 * @since 1.0.0
 * @category constructors
 */
export const reconcileHistory = (connection: Bridge.ConnectionOptions, runtime: Bridge.Runtime = {}): void => {
  if (
    connection.remote !== undefined ||
    Environment.read(runtime.environment ?? process.env, "SMITHERS_REMOTE") !== undefined
  ) return
  History.reconcile(History.localRoot(connection, runtime.environment ?? process.env))
}

/**
 * Resolves the worktree passed through Bridge.Runtime before a local resume.
 * @since 1.0.0
 * @category constructors
 */
export const prepareHistoryRun = (
  runId: string,
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime = {}
): { executionRoot?: string } => {
  if (
    connection.remote !== undefined ||
    Environment.read(runtime.environment ?? process.env, "SMITHERS_REMOTE") !== undefined
  ) return {}
  return History.prepare(History.localRoot(connection, runtime.environment ?? process.env), runId)
}

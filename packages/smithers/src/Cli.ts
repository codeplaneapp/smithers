/**
 * Unified Incur CLI; Effect remains the durable execution and service runtime.
 * Command handlers acquire services only after parsing, keeping help/schema inert.
 * @since 1.0.0
 */
import { makeCli as makeBuildCli } from "@smthrs/build-cli/Cli"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import { Effect, Logger } from "effect"
import { Cli, z } from "incur"
import { resolve } from "node:path"
import * as Agents from "./Agents.ts"
import * as Argv from "./cli/Argv.ts"
import * as Bridge from "./cli/ControlBridge.ts"
import { createApprovalsCli, createFlowCli, createRunsCli, safe } from "./cli/ControlCommands.ts"
import { createGenerateCli, initialize } from "./cli/Generate.ts"
import { appendHistoryCommands } from "./cli/HistoryCommands.ts"
import * as Presentation from "./cli/Presentation.ts"
import * as CliError from "./CliError.ts"
import { createEvalCli } from "./evaluation/Cli.ts"
import * as Init from "./Init.ts"
import { createCredentialsCli } from "./operator/Credentials.ts"
import { createIntegrationsCli } from "./operator/Integrations.ts"
import { createMemoryCli } from "./operator/Memory.ts"
import { localRoot } from "./operator/Store.ts"
import { createTriggersCli } from "./operator/Triggers.ts"
import * as Serve from "./Serve.ts"
import * as Suggest from "./Suggest.ts"
import * as Ui from "./Ui.ts"
import * as Unsupported from "./Unsupported.ts"
import { packageVersion } from "./Version.ts"

const options = Bridge.connectionOptions

/**
 * Construct the public command tree without opening stores or evaluating declarations.
 * @category constructors
 * @since 1.0.0
 */
export const makeCli = (config: Bridge.Runtime = {}): ReturnType<typeof makeBuildCli> => {
  const mcp = Cli.create("mcp", {
    version: packageVersion,
    description: "Register the Smithers MCP server with an agent",
    globals: z.object({
      audience: z.enum(["auto", "human", "agent"]).default("auto"),
      silent: z.boolean().default(false),
      ui: z.enum(["auto", "tty", "stream", "plain"]).default("auto")
    })
  }).command("add", {
    description: "Register with Claude Code or Codex; omit --agent to configure both",
    mcp: false,
    options: options.extend({ agent: z.string().optional() }),
    run: (c) =>
      safe(c, async () => {
        const requested = c.options.agent
        const targets = requested === undefined
          ? Agents.agents
          : Agents.agents.filter((agent) => agent.id === requested)
        if (targets.length === 0) {
          throw new CliError.UsageError({
            message: `Unknown agent ${requested}. Known agents: ${Agents.agents.map((agent) => agent.id).join(", ")}`
          })
        }
        const wired = targets.map((agent) => Agents.addMcp(agent, (config.environment ?? process.env)["HOME"]))
        if (wired.every((entry) => entry.status === "failed")) {
          const stderr = config.stderr ?? process.stderr
          stderr.write(`${Agents.manualInstructions(targets.map((agent) => agent.id))}\n`)
          throw new CliError.UnsupportedError({ message: "Could not register the MCP server" })
        }
        return wired
      })
  })
  mcp.use((context, next) => Presentation.scope(context, config, next))
  const cli = makeBuildCli({
    ...config,
    cliName: "smthrs",
    cliVersion: packageVersion,
    cliDescription: "Build workspace targets and operate durable agent workflows"
  })
  cli.use((context, next) => Presentation.scope(context, config, next))
  cli
    .command(createFlowCli(config))
    .command(appendHistoryCommands(createRunsCli(config), config))
    .command(createApprovalsCli(config))
    .command(createGenerateCli(config))
    .command(createMemoryCli())
    .command(mcp)
    .command(createCredentialsCli())
    .command(createTriggersCli(config))
    .command(createIntegrationsCli())
    .command(createEvalCli(config))
    .command("init", {
      description: "Initialize workspace and target declarations plus a starter flow, preserving existing files",
      args: z.object({ name: z.string().optional() }),
      options: z.object({
        root: z.string().optional().describe("Directory to initialize; defaults to cwd"),
        global: z.boolean().default(false).describe("Removed; initialize a workspace instead")
      }),
      run: (c) =>
        safe(c, () => {
          if (c.options.global) throw Unsupported.flagError(Unsupported.findFlag("init", "global"))
          const root = resolve(c.options.root ?? process.cwd())
          return initialize(root, c.args.name ?? Init.defaultName(root), config.environment ?? process.env)
        })
    })
    .command("doctor", {
      description: "Check project discovery, providers, tools, and durable-state compatibility",
      options,
      run: (c) => safe(c, () => Bridge.invoke(["doctor"], c.options, config))
    })
    .command("serve", {
      aliases: ["gateway"],
      description: "Host the control gateway and durable trigger scheduler",
      mcp: false,
      options: options.extend({
        host: z.string().default(Serve.defaultBind.host),
        port: z.number().int().min(0).max(65535).default(Serve.defaultBind.port),
        listen: z.boolean().default(false)
      }),
      run: (c) =>
        safe(
          c,
          () =>
            Bridge.host(
              {
                host: c.options.host,
                port: c.options.port,
                listen: c.options.listen,
                credential: c.options.credential ?? (config.environment ?? process.env)["SMITHERS_API_KEY"]
              },
              c.options,
              config
            )
        )
    })
    .command("gc", {
      description: "Collect old terminal runs and compact their journals; separate from target caches",
      destructive: true,
      options: options.extend({ olderThan: z.string().default("30d"), dryRun: z.boolean().default(false) }),
      run: (c) =>
        safe(c, () => {
          localRoot(c.options)
          return Bridge.invoke(
            ["gc", "--older-than", c.options.olderThan, ...(c.options.dryRun ? ["--dry-run"] : [])],
            c.options,
            config
          )
        })
    })
    .command("suggest", {
      description: "Discover ways Smithers can help; interactively choose one to implement",
      args: z.object({ path: z.string().optional() }),
      options: z.object({ root: z.string().optional(), seat: z.string().optional(), list: z.boolean().default(false) }),
      run: (c) =>
        safe(c, async () => {
          const root = c.args.path === undefined ? localRoot(c.options) : resolve(c.args.path)
          if (!Suggest.isDirectory(root)) {
            throw new CliError.UsageError({ message: `The path must be a directory: ${root}` })
          }
          const documents: Array<unknown> = []
          const presentation = Presentation.current()?.policy ?? Presentation.policy(c, config)
          const json = presentation.structured
          const outcome = await Effect.runPromise(
            Suggest.run({
              root,
              seat: c.options.seat,
              list: c.options.list,
              json,
              environment: config.environment ?? process.env,
              emit: (line) => {
                documents.push(JSON.parse(line))
              }
            }).pipe(
              Effect.provideService(
                Ui.Ui,
                Ui.make({
                  output: Presentation.current()?.stderr ?? process.stderr,
                  input: process.stdin,
                  interactive: presentation.interactive
                })
              ),
              Effect.provide(RedactedLogger.layer()),
              Effect.provideService(Logger.LogToStderr, true)
            ),
            { signal: config.signal }
          )
          config.exit?.(Suggest.exitStatus(outcome))
          return json ? { ...outcome, documents } : undefined
        })
    })
    .command("migrate", {
      description: "Inventory, plan, or apply the 0.x-to-1.x source migration",
      args: z.object({ path: z.string().optional() }),
      options: options.extend({
        scan: z.boolean().default(false),
        apply: z.boolean().default(false),
        seat: z.string().optional(),
        allowUnsafe: z.string().optional(),
        acknowledgeRunState: z.boolean().default(false),
        allowNoVcs: z.boolean().default(false),
        keepOldSources: z.boolean().default(false),
        unit: z.string().optional(),
        maxRepairRounds: z.number().int().nonnegative().optional(),
        reportDir: z.string().optional(),
        flowsDir: z.string().optional(),
        verifyInstall: z.string().optional(),
        verifyFormat: z.string().optional(),
        verifyTypecheck: z.array(z.string()).optional(),
        verifyTest: z.string().optional()
      }),
      run: (c) =>
        safe(c, () => {
          localRoot(c.options)
          const args = ["migrate", ...(c.args.path === undefined ? [] : [c.args.path])]
          for (const [key, value] of Object.entries(c.options)) {
            if (key in options.shape || value === undefined || value === false) continue
            const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
            if (Array.isArray(value)) { for (const item of value) args.push(flag, item) }
            else args.push(flag, ...(value === true ? [] : [String(value)]))
          }
          return Bridge.invoke(args, c.options, config)
        })
    })
    .command("update", {
      description: "Check the registry for newer CLI versions; does not install them",
      options,
      run: (c) => safe(c, () => Bridge.invoke(["update"], c.options, config))
    })
    .command("bug", {
      description: "Submit a redacted bug report to the configured endpoint",
      args: z.object({ summary: z.array(z.string()).min(1) }),
      options: options.extend({
        run: z.string().optional(),
        yes: z.boolean().default(false).describe("Post the previewed report without an interactive confirmation"),
        dryRun: z.boolean().default(false).describe("Preview the redacted report without posting")
      }),
      run: (c) =>
        safe(
          c,
          () =>
            Bridge.invoke(
              [
                "bug",
                ...c.args.summary,
                ...(c.options.run ? ["--run", c.options.run] : []),
                ...(c.options.yes ? ["--yes"] : []),
                ...(c.options.dryRun ? ["--dry-run"] : [])
              ],
              c.options,
              config
            )
        )
    })
  // Incur 0.5 intercepts `mcp` before looking up registered commands. Dispatch
  // the mounted subtree directly so registration uses Agents.addMcp as documented.
  const serve = cli.serve.bind(cli)
  cli.serve = (argv = process.argv.slice(2), serveOptions) => {
    const parsed = Argv.parse(argv)
    let offset = 0
    // Argv retains document switches and --ui in rest; use its parsed option
    // values to skip those prefixes without mistaking their values for verbs.
    while (parsed.rest[offset]?.startsWith("-") && parsed.rest[offset] !== "--") {
      const flag = parsed.rest[offset]!
      const value = parsed.options.get(flag.split("=")[0]!)
      offset += !flag.includes("=") && typeof value === "string" ? 2 : 1
    }
    const index = parsed.restIndices[offset]
    if (parsed.rest[offset] === "mcp" && index !== undefined && !argv.includes("--mcp")) {
      return mcp.serve([...argv.slice(0, index), ...argv.slice(index + 1)], serveOptions)
    }
    return serve(argv, serveOptions)
  }
  return cli
}

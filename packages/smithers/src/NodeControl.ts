/**
 * Node transport composition for the Control service.
 *
 * @since 0.1.0
 */
import { NodeCrypto, NodeHttpClient, NodeHttpServer, NodeServices, NodeSocket } from "@effect/platform-node"
import type * as Undici from "@effect/platform-node/Undici"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import {
  Control,
  ControlExecutor,
  ControlRpcs,
  ControlRuntime,
  ControlServer,
  SqlControlRuntime,
  SystemFlows
} from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import * as NodeFlowsRuntime from "@smthrs/flows/NodeRuntime"
import type * as GatewayServer from "@smthrs/gateway/GatewayServer"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as GatewayProjections from "@smthrs/gateway/Projections"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import type * as McpClient from "@smthrs/mcp/McpClient"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import * as MemoryError from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import type * as ModelError from "@smthrs/model/ModelError"
import * as OpenAIChatGPT from "@smthrs/model/OpenAIChatGPT"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import type { NotificationQueue } from "@smthrs/notifications"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Migrations as RunStoreMigrations, Ownership, RunStore } from "@smthrs/run-store"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Container from "@smthrs/std/Container"
import * as NativeSearch from "@smthrs/std/NativeSearch"
import * as TestRunner from "@smthrs/std/TestRunner"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import type { FileSystem, Path, Result } from "effect"
import { Context, Effect, Exit, Layer, Redacted, Scope, Semaphore } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { ListenOptions } from "node:net"
import { hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import * as Application from "./Application.ts"
import * as CliError from "./CliError.ts"
import * as CodexAuth from "./CodexAuth.ts"
import * as Environment_ from "./Environment.ts"
import * as Output from "./Output.ts"
import * as Project from "./Project.ts"
import * as Providers from "./Providers.ts"
import * as Serve from "./Serve.ts"

/**
 * The environment subset consulted while resolving Node application
 * configuration.
 *
 * Names are read through `Environment.read`. Pass a captured source to
 * configuration helpers so tests and alternate hosts do not read ambient
 * process state; invalid values fail through the helper that consumes them.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = Environment_.Source

/**
 * Node HTTP listen options accepted by the control server.
 *
 * Use these at a Node bind boundary. A non-loopback host without the required
 * opt-in is rejected synchronously before the server layer is built.
 *
 * @category models
 * @since 0.1.0
 */
export type ServerOptions = ListenOptions & {
  readonly disablePreemptiveShutdown?: boolean | undefined
  /** Explicit opt-in corresponding to the host CLI's `--listen` flag. */
  readonly listen?: boolean | undefined
}

const valueFromArguments = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === `--${flag}`) return args[index + 1]
    if (argument?.startsWith(`--${flag}=`)) return argument.slice(flag.length + 3)
  }
  return undefined
}

/** One entry of an `--mcp-config` file, structurally `McpClient.ConnectOptions`. */
const isMcpServerEntry = (value: unknown): value is McpClient.ConnectOptions => {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  const positiveInteger = (key: string) =>
    entry[key] === undefined || (typeof entry[key] === "number" && Number.isInteger(entry[key]) && entry[key] > 0)
  const env = entry.env
  return typeof entry.server === "string" &&
    typeof entry.command === "string" &&
    Array.isArray(entry.args) && entry.args.every((argument) => typeof argument === "string") &&
    (entry.cwd === undefined || typeof entry.cwd === "string") &&
    (env === undefined || (
      typeof env === "object" && env !== null &&
      Object.values(env).every((item) => item === undefined || typeof item === "string")
    )) &&
    positiveInteger("handshakeTimeoutMs") &&
    positiveInteger("requestTimeoutMs") &&
    positiveInteger("queueCapacity") &&
    positiveInteger("maxFrameBytes")
}

/**
 * Reads and validates the MCP servers named by `--mcp-config`/`SMITHERS_MCP_CONFIG`.
 *
 * The file is a JSON array of `{server, command, args, cwd?, env?,
 * handshakeTimeoutMs?, requestTimeoutMs?, queueCapacity?, maxFrameBytes?}`
 * entries, exactly `McpClient.ConnectOptions`. Omitting the setting configures
 * no MCP servers. A named path that is missing, unreadable, malformed, or has
 * the wrong shape raises a flag-specific usage error rather than silently
 * changing the executor's tool catalog.
 *
 * @category constructors
 * @since 0.1.0
 */
const mcpServersFromArguments = (
  args: ReadonlyArray<string>,
  environment: Environment
): ReadonlyArray<McpClient.ConnectOptions> | undefined => {
  const path = valueFromArguments(args, "mcp-config") ?? Environment_.read(environment, "SMITHERS_MCP_CONFIG")
  if (path === undefined) return undefined
  if (!existsSync(path)) {
    throw new CliError.UsageError({ message: `--mcp-config ${path}: file not found` })
  }
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new CliError.UsageError({ message: `--mcp-config ${path} could not be read: ${reason}` })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new CliError.UsageError({ message: `--mcp-config ${path} is not valid JSON: ${reason}` })
  }
  if (!Array.isArray(parsed) || !parsed.every(isMcpServerEntry)) {
    throw new CliError.UsageError({
      message: `--mcp-config ${path} must contain a JSON array of MCP server entries`
    })
  }
  return parsed
}

/**
 * Resolves application configuration from command arguments with an
 * environment fallback.
 *
 * Use this before constructing any durable layer. Invalid `--remote` and
 * `--mcp-config` values raise `CliError.UsageError`, naming the offending flag
 * before a transport or database can surface a lower-level exception.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeConfig = (
  args: ReadonlyArray<string>,
  environment: Environment,
  cwd: string
): Application.Config => {
  const remote = valueFromArguments(args, "remote") ?? Environment_.read(environment, "SMITHERS_REMOTE")
  if (remote !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(remote)
    } catch {
      throw new CliError.UsageError({
        message: `--remote must be an http:// or https:// URL; got ${JSON.stringify(remote)}`
      })
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError.UsageError({
        message: `--remote must be an http:// or https:// URL; got ${JSON.stringify(remote)}`
      })
    }
  }
  return {
    remote,
    // The imported reference gave `--credential` no environment
    // fallback, so a hosted gateway had to spell the token on every command
    // line (the release policy).
    credential: valueFromArguments(args, "credential") ?? Environment_.read(environment, "SMITHERS_API_KEY"),
    mcpServers: mcpServersFromArguments(args, environment),
    // `--root` is resolved here rather than in a handler because the durable
    // layers are built from it, and they are built before any flag is parsed.
    root: Project.root(valueFromArguments(args, "root"), cwd),
    // `migrate` converts a 0.x project, which by definition has no `.flows/`
    // for the root walk to anchor on. Resolved from the same `--root`, and
    // otherwise from the 0.x state beside the invocation directory.
    migrationRoot: Project.legacyRoot(valueFromArguments(args, "root"), cwd)
  }
}

/**
 * Resolves configuration for the current Node process.
 *
 * The executable reaches for this effect before parsing the command tree. It
 * preserves configuration usage errors so the top-level reporter exits with
 * status 2 and never leaks a host exception.
 *
 * @category configuration
 * @since 0.1.0
 */
export const config: Effect.Effect<Application.Config, CliError.UsageError> = Effect.try({
  try: () => makeConfig(process.argv.slice(2), process.env, process.cwd()),
  catch: (cause) =>
    cause instanceof CliError.UsageError
      ? cause
      : new CliError.UsageError({
        message: cause instanceof Error ? cause.message : "Smithers configuration could not be read"
      })
})

const websocketUrl = (remote: string): string => {
  const url = new URL(remote)
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/rpc$/, "")
  url.pathname = `${basePath}/rpc/ws`
  url.search = ""
  url.hash = ""
  return url.toString()
}

const websocketLayer = (remote: string, credential: string | undefined) => {
  const url = websocketUrl(remote)
  if (credential === undefined) return NodeSocket.layerWebSocket(url)
  return Socket.layerWebSocket(url).pipe(
    Layer.provide(
      Layer.succeed(
        Socket.WebSocketConstructor,
        (address, protocols) =>
          new NodeSocket.NodeWS.WebSocket(address, protocols, {
            headers: { authorization: `Bearer ${credential}` }
          }) as unknown as globalThis.WebSocket
      )
    )
  )
}

/**
 * The flow sources a local CLI discovers: the project `flows/` directory, whose
 * per-directory layout is the convention in
 * `docs/specs/Specs/Flow Directory.md`.
 *
 * Use this when building a project registry. It is pure and cannot fail; the
 * discovery layer reports unreadable or malformed sources later.
 *
 * @category constructors
 * @since 0.1.0
 */
export const projectSources = (root: string): ReadonlyArray<Descriptor.Source> => [
  { source: "project", root: join(root, "flows"), naming: "path" }
]

/**
 * The raw host platform: Node's own services plus the descriptor-relative,
 * no-follow filesystem the kernel needs underneath it. `NodeServices` alone is
 * not enough: the kernel's guarded `FileSystem` refuses every operation unless
 * the host provides descriptor-relative, no-follow access, which is what
 * `AtomicFileSystem` adds on Node.
 *
 * This is the *unguarded* half of the composition. It is what
 * {@link layerGuardedPlatform} is built on, and it is what host equipment that
 * carries its own confinement argument runs on, today only the workspace
 * observer, whose module documents why (`@smthrs/agent/WorkspaceObservation`).
 * Agent-reachable equipment never gets this layer: a flow, a tool, or anything
 * a model can steer takes {@link layerGuardedPlatform} so the kernel decides
 * what it may touch.
 *
 * One `const`, not a function, so every consumer in one composition shares a
 * single memoized build. Host acquisition failures remain startup failures in
 * the layers that consume it.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHostPlatform = Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer)

/**
 * The local CLI's real permission store.
 *
 * Its configured rule preserves the operator-owned CLI's allow policy, while
 * the real store still enforces the fiber's capability ceiling. This is
 * intentionally distinct from `GrantStore.layerNoop`, which skips both policy
 * evaluation and ceiling enforcement and is suitable only as an explicit test
 * input.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerGrantStore = (root: string): Layer.Layer<GrantStore.GrantStore> =>
  GrantStore.layer({
    attended: false,
    rules: [
      new Rule({
        effect: "allow",
        pattern: new CapabilityPattern({ action: "*", resource: "*" })
      })
    ]
  }).pipe(
    Layer.provide(Workspace.layer(resolve(root))),
    Layer.orDie
  )

/**
 * The kernel-guarded platform over one workspace root: every filesystem
 * operation resolved, authorized, re-resolved, and executed relative to a
 * pinned root descriptor.
 *
 * `grants` is the store the kernel asks before it authorizes an operation, and
 * it is a parameter rather than a constant so that one composition cannot end
 * up asking two different stores. The default is the local CLI's real store;
 * a hosted composition may supply a stricter `GrantStore`, and must supply the same one it gives
 * `KernelChildProcessSpawner`: a filesystem pinned to the allow-all store
 * beside a shell pinned to a real one is a fail-open the types would not catch.
 *
 * The confinement the kernel still enforces here is structural: canonical
 * resolution, the hard-link refusal, and descriptor-relative execution from a
 * pinned root. That is what costs: on Node one authorized operation is one
 * helper process, so a caller that performs one operation per file in a
 * checkout pays for the whole checkout. That is a cost to spend on
 * agent-reachable equipment and to refuse for a whole-tree walk; see
 * {@link layerHostPlatform}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerGuardedPlatform = (
  root: string,
  grants: Layer.Layer<GrantStore.GrantStore> = layerGrantStore(root)
) =>
  Layer.orDie(KernelFileSystem.layer).pipe(
    Layer.provide([Workspace.layer(root), grants]),
    Layer.provideMerge(layerHostPlatform)
  )

/**
 * Provides the workspace observer the run's mutation accounting is measured
 * with: one pruned walk of the workspace root, taken at both ends of every
 * frame.
 *
 * On {@link layerHostPlatform}, deliberately, and never on
 * {@link layerGuardedPlatform}. The observer is host equipment: the root is
 * this composition's, not a model's. It carries its own confinement
 * argument: it stats, it never opens, it follows no symlink, and every path it
 * builds is an entry name under the root. `@smthrs/agent/WorkspaceObservation`
 * states that argument in full. Guarding it decides nothing and costs one
 * helper process per file: SWE-bench wave 6 spent 912 s of a 1,200 s budget on
 * django's opening walk and never reached the agent's first tool call.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerObserver = (root: string): Layer.Layer<WorkspaceObservation.Observer> =>
  WorkspaceObservation.layer(root).pipe(Layer.provide(layerHostPlatform))

/**
 * Provides the Node-backed flow registry the local CLI discovers flows with.
 *
 * `Registry.layerNoop()` was the previous local composition, so the CLI found
 * no flows at all. Discovery runs under an allow-all grant store because the
 * local CLI is the operator's own process; a hosted composition supplies a real
 * `GrantStore`. A source root that does not exist scans empty, so this is not a
 * startup failure. An unreadable one is, and dies rather than silently
 * discovering nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerRegistry = (root: string): Layer.Layer<Registry.Registry> => {
  const platform = layerGuardedPlatform(root)
  const discovery = Discovery.layer.pipe(Layer.provide(platform))
  return Registry.layer({ sources: projectSources(root) }).pipe(
    Layer.provide([discovery, platform]),
    // A project with no `flows/` directory simply has no flows. Every other
    // discovery failure, such as an unreadable root or malformed entry, is a startup
    // defect rather than a silent empty catalog.
    Layer.catch((error) =>
      error.code === "root_missing"
        ? Registry.layerFromDescriptors([]).pipe(Layer.provide(platform))
        : Layer.effect(Registry.Registry)(Effect.die(error))
    )
  )
}

/**
 * Where a local CLI keeps its control-plane database.
 *
 * Use this instead of assembling `.flows` paths at call sites. It is a pure
 * path projection and cannot fail; opening the returned file can.
 *
 * @category constructors
 * @since 0.1.0
 */
export const databasePath = (root: string): string => join(root, ".flows", "control.db")

/**
 * Where the durable flow engine keeps executions, attempts, cache entries,
 * and wake state. The control plane has a separate connection and schema in
 * {@link databasePath}; keeping the files separate makes each composition's
 * migration ownership explicit.
 * This is a pure path projection; engine startup reports creation or migration
 * failures when it opens the file.
 *
 * @category constructors
 * @since 0.1.0
 */
export const executionDatabasePath = (root: string): string => join(root, ".flows", "engine.db")

/**
 * `Application.Engine` plus the shared database seam the Node composition
 * hangs additional stores off; the memory store reuses the same connection
 * the runtime and journal commit against.
 *
 * Pass the same value to every local consumer. Building its component layers
 * independently can open multiple writers; the complete composition
 * materializes them once and reuses the captured services.
 *
 * @category models
 * @since 0.1.0
 */
export interface EngineDurable extends Application.Engine {
  readonly stores: Layer.Layer<DurableWriter.DurableWriter | SqlClient | RunStore.RunStore>
}

/**
 * Acquires one durable graph and projects its live services back into layers.
 *
 * Nested `Layer.provide` calls build with independent memo maps, so merely
 * passing the same layer value to the runtime, journal, executor, and memory
 * store still opened one SQLite connection per consumer. Building the merged
 * graph in the caller's scope first gives every consumer the same live service
 * values, and closing that scope closes the sole connection.
 */
const materializeEngine = (engine: EngineDurable): Effect.Effect<EngineDurable, never, Scope.Scope> =>
  Effect.map(
    Layer.build(Layer.mergeAll(engine.runtime, engine.journal, engine.stores)),
    (services) => ({
      runtime: Layer.succeed(
        ControlRuntime.ControlRuntime,
        Context.get(services, ControlRuntime.ControlRuntime)
      ),
      journal: Layer.succeed(Journal.Journal, Context.get(services, Journal.Journal)),
      stores: Layer.mergeAll(
        Layer.succeed(DurableWriter.DurableWriter, Context.get(services, DurableWriter.DurableWriter)),
        Layer.succeed(SqlClient, Context.get(services, SqlClient)),
        Layer.succeed(RunStore.RunStore, Context.get(services, RunStore.RunStore))
      )
    })
  )

/**
 * The reserved system catalog in the durable runtime's flow shape.
 *
 * The reserved verbs make no model calls of their own, so there is nothing for
 * a ceiling to bound and `Descriptor.budgetUnbounded` says so by name rather
 * than by an unlabelled `{}`.
 */
const systemFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = SystemFlows.catalog.map((entry) => ({
  flowId: entry.flowId,
  description: `Reserved ${entry.verb} system flow`,
  deployClass: entry.deployClass,
  envelope: { capabilities: [], flows: [], budget: Descriptor.budgetUnbounded }
}))

/**
 * Projects one discovered flow into the durable runtime's flow shape.
 *
 * The budget travels with the capabilities because it is enforced the same way
 * they are: `layerExecutor` hands `Budget.layerFromEnvelope` to `AgentSession`,
 * which builds one budget per run out of the approved card's envelope. A
 * hardcoded `{}` here made that enforcement bind nothing on the shipped CLI,
 * however carefully a flow declared its ceilings. `Descriptor.budgetOf` answers
 * the undeclared case with `budgetUnbounded`, so a flow that names no ceiling
 * still runs and a flow that names one is held to it.
 */
const durableFlow = (descriptor: Descriptor.FlowDescriptor): ControlRuntime.MemoryFlow => ({
  flowId: descriptor.name,
  description: descriptor.description,
  deployClass: false,
  envelope: {
    capabilities: descriptor.capabilities,
    flows: descriptor.flows,
    budget: Descriptor.budgetOf(descriptor)
  }
})

/**
 * Provides the durable local engine: `SqlControlRuntime` and the production
 * SQL journal, both over one SQLite file under the project root.
 *
 * The previous local composition was `ControlRuntime.layerMemory()` over
 * `TestJournal`, an in-memory database, so no plan, approval, run, or journal
 * entry survived the process. Sharing one connection between the runtime and
 * the journal is deliberate: the fenced run transitions and the events that
 * describe them then commit against the same database.
 *
 * With a `registry`, the runtime knows every discovered flow as well as the
 * reserved system catalog, so `smthrs plan <flow>` plans a project flow
 * instead of failing `FlowNotFound`.
 *
 * Reach for this value at a Node composition root and reuse it. Database open,
 * migration, and journal startup failures are promoted to defects because no
 * local command can proceed honestly without the store.
 *
 * @category layers
 * @since 0.1.0
 */
export const engineDurable = (
  root: string,
  registry?: Layer.Layer<Registry.Registry> | undefined
): EngineDurable => {
  const file = databasePath(root)
  // One real process identity per local control plane. A constant pid made two
  // CLIs on one host appear to own the same fence and allowed the loser to
  // re-drive work claimed by the winner.
  const owner = Object.freeze({ hostId: hostname(), pid: process.pid, nonce: randomUUID() })
  // Suspended so a `--remote` invocation, which never builds this layer, does
  // not leave an empty `.flows/` behind. SQLite opens a file but will not
  // create the directory holding it, and a missing one is the first-run case,
  // not an error.
  const database = Layer.provideMerge(
    Layer.merge(Migrations.layer, RunStoreMigrations.layer),
    Layer.provideMerge(
      DurableWriter.layer(),
      Layer.suspend(() => {
        mkdirSync(dirname(file), { recursive: true })
        return NodeDatabase.layer({ filename: file })
      })
    )
  ).pipe(Layer.orDie)
  // A control plane that cannot open its own database has nothing to serve, so
  // a failed open, migration, or journal start is a startup defect rather than
  // a typed control-plane error every command would have to carry.
  const stores = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(database),
    Layer.orDie
  )
  const runtime = registry === undefined
    ? SqlControlRuntime.layer({ owner }).pipe(Layer.provide([stores, NodeCrypto.layer]), Layer.orDie)
    : Layer.effect(ControlRuntime.ControlRuntime)(
      Effect.gen(function*() {
        const registryService = yield* Registry.Registry
        const discovered = yield* registryService.list()
        return yield* SqlControlRuntime.make({ owner, flows: [...systemFlows, ...discovered.map(durableFlow)] })
      })
    ).pipe(Layer.provide([stores, NodeCrypto.layer, registry]), Layer.orDie)
  return {
    runtime,
    journal: stores,
    stores
  }
}

const apiKeyVariable: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
}

/**
 * How the `openai` provider authenticates. `api-key` is the default and the
 * only mode the other providers have. `chatgpt` routes the same seat strings
 * to the ChatGPT-subscription backend on the codex CLI's OAuth session, so a
 * lane opts in through the environment without respelling any seat: the
 * journaled seat, its context window, and its committed price stay identical.
 */
const openaiAuthVariable = "SMITHERS_OPENAI_AUTH"

/**
 * The Node seat resolver: it turns a `provider:modelId` seat into a live model
 * route, with the API key read from the given environment, usually
 * `process.env`, passed in as a value so nothing below this composition touches
 * the process directly.
 *
 * A seat with no separator is a bare model id on the Anthropic route, which is
 * the one provider convention this host assumes.
 *
 * `SMITHERS_OPENAI_AUTH=chatgpt` swaps the `openai` provider's credential source
 * from `OPENAI_API_KEY` to the codex CLI's ChatGPT session
 * (`$CODEX_HOME/auth.json`); the token store is shared across every seat that
 * resolves against the same file so its refresh stays single-flight.
 *
 * @category constructors
 * @since 0.1.0
 */
export const seatResolver = (
  environment: Readonly<Record<string, string | undefined>>,
  executor: RequestExecutor.RequestExecutor
): SeatResolver.Service => {
  const codexStores = new Map<string, CodexAuth.Store>()
  const codexStore = (file: string): CodexAuth.Store => {
    let store = codexStores.get(file)
    if (store === undefined) {
      store = CodexAuth.make({ file, executor })
      codexStores.set(file, store)
    }
    return store
  }
  return SeatResolver.make({
    resolve: (seat) =>
      Effect.gen(function*() {
        const separator = seat.indexOf(":")
        const provider = separator < 0 ? "anthropic" : seat.slice(0, separator)
        const modelId = Seat.modelIdOf(seat)
        // The OpenAI-compatible Chat Completions providers are routed by
        // table (`Providers.compatible`): the origin, the exact path, and the
        // key variables read in order. `Object.hasOwn`, so `constructor:x`
        // finds no inherited function.
        if (Object.hasOwn(Providers.compatible, provider)) {
          const entry = Providers.compatible[provider]!
          const found = Providers.compatibleKey(provider, environment)
          if (found === undefined) {
            return yield* new Seat.SeatUnresolved({
              seat,
              message: `Set ${entry.variables.join(" or ")} to run the ${seat} seat`
            })
          }
          return yield* seatOf(
            Route.openaiChatCompatible({
              id: provider,
              baseUrl: entry.baseUrl,
              path: entry.path,
              apiKey: Redacted.make(found.key)
            }),
            executor,
            seat,
            modelId
          )
        }
        const variable = apiKeyVariable[provider]
        if (variable === undefined) {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `No route is configured for the ${provider} provider`
          })
        }
        // An empty value is treated exactly like an unset variable, the same
        // convention the key variables follow below.
        const configured = Environment_.read(environment, openaiAuthVariable)
        const authMode = provider === "openai" && configured !== undefined && configured !== ""
          ? configured
          : "api-key"
        if (authMode !== "api-key" && authMode !== "chatgpt") {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `${openaiAuthVariable} must be "api-key" or "chatgpt" to run the ${seat} seat`
          })
        }
        if (authMode === "chatgpt") {
          // The ChatGPT mode needs a provisioned session, not an API key: the
          // refusal names the store so a detached lane fails before spending.
          const file = CodexAuth.locate(environment)
          if (!existsSync(file)) {
            return yield* new Seat.SeatUnresolved({
              seat,
              message: `Sign in with \`codex login\` to run the ${seat} seat: no ChatGPT credentials at ${file}`
            })
          }
          return yield* seatOf(
            OpenAIChatGPT.make({ auth: codexStore(file).auth({ modelId }) }),
            executor,
            seat,
            modelId
          )
        }
        const key = environment[variable]
        if (key === undefined || key.length === 0) {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `Set ${variable} to run the ${seat} seat`
          })
        }
        // The provider routes have distinct body types, so each branch is
        // erased into the seat shape on its own rather than through a union.
        // OpenRouter is the OpenAI Responses surface at a different origin, so
        // its seats spell the model as `openrouter:vendor/model` and route
        // through the compatible constructor.
        return yield* provider === "anthropic"
          ? seatOf(Route.anthropic({ apiKey: Redacted.make(key) }), executor, seat, modelId)
          : provider === "openrouter"
          ? seatOf(
            Route.openaiResponsesCompatible({
              id: "openrouter",
              baseUrl: "https://openrouter.ai/api",
              apiKey: Redacted.make(key)
            }),
            executor,
            seat,
            modelId
          )
          : seatOf(Route.openai({ apiKey: Redacted.make(key) }), executor, seat, modelId)
      })
  })
}

const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError.ModelError>,
  executor: RequestExecutor.RequestExecutor,
  seat: string,
  modelId: string
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  Effect.gen(function*() {
    const routeConfig = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => new Seat.SeatUnresolved({ seat, message: error.message }))
    )
    const model = yield* Route.toModel(routeConfig).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    return Seat.make({
      id: seat,
      model,
      route: FlowEngineLike.routeResolver(routeConfig),
      contextWindowTokens: SeatResolver.contextWindowTokensFor(modelId)
    })
  })

/**
 * Provides {@link seatResolver} over the composition's request dispatcher.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSeatResolver = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<SeatResolver.SeatResolver, never, RequestExecutor.RequestExecutor> =>
  Layer.effect(SeatResolver.SeatResolver)(
    Effect.gen(function*() {
      const executor = yield* RequestExecutor.RequestExecutor
      return seatResolver(environment, executor)
    })
  )

/**
 * The explicit sandbox budget every locally executed cell runs under. Never
 * unlimited: an unbounded QuickJS cell can hang the frame.
 */
const cellLimits: Sandbox.Limits = {
  memoryBytes: 256 * 1024 * 1024,
  steps: 50_000_000
}

/**
 * The repository's own test invocation, as this host declares it.
 *
 * `TestRun` is a declaration flow: a caller selects *which* tests, never *how*
 * to run them, so the composition has to supply the how. This host reads it off
 * the environment, which is the same place it reads a seat's credentials, and
 * the only field that decides anything is the command. The rest describe where
 * that command runs.
 *
 * `undefined` means this host knows of no runner, and then the `test` flow is
 * not bound at all. That is the rule the r91 wave broke in the other direction:
 * `StandardFlows.tests` existed, the cell contract's doctrine assumed it, and
 * no composition offered it, so all 45 graded runs saw zero `test` calls. A
 * flow no composition offers is a flow that does not exist, and a flow bound
 * over a declaration that can only refuse is worse, because the catalog then
 * advertises a call whose every answer is "not configured".
 *
 * @category constructors
 * @since 0.1.0
 */
export const testRunner = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string
): TestRunner.Runner | undefined => {
  const command = Environment_.read(environment, "SMITHERS_TEST_COMMAND")?.trim()
  if (command === undefined || command === "") return undefined
  const container = Environment_.read(environment, "SMITHERS_TEST_CONTAINER")?.trim()
  const cwd = Environment_.read(environment, "SMITHERS_TEST_CWD")?.trim()
  const timeout = Number(Environment_.read(environment, "SMITHERS_TEST_TIMEOUT_MS"))
  return {
    command,
    // The runner's directory and the repository's are the same path until a
    // container gives the tree a second name; `root` stays the host's, because
    // that is where a baseline worktree is checked out from.
    cwd: cwd === undefined || cwd === "" ? root : cwd,
    root,
    ...(container === undefined || container === "" ? {} : { container }),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {})
  }
}

/**
 * Where this host pins the trees a run checkpoints, and where a container sees
 * them.
 *
 * The same two paths {@link testRunner} reads, for the same reason: a
 * checkpoint is materialized as a directory under the repository, and a
 * container reaches that directory through the mount it already has.
 * `SMITHERS_TEST_CWD` is the container's name for the repository when there is
 * one, and the workspace root is the host's. A host that declares neither
 * still pins, and pins on one path under both names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkpointStore = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string
): Checkpoints.GitOptions => {
  const cwd = Environment_.read(environment, "SMITHERS_TEST_CWD")?.trim()
  return { root, ...(cwd === undefined || cwd === "" ? {} : { cwd }) }
}

/**
 * The `test` flow's binding source, or none when this host declares no runner.
 *
 * Named rather than spread inline because the r91 wave's whole finding about
 * this flow is that the *composition* was the untried link: the flow, its
 * declaration and its handler were all tested, and no test asked whether any
 * host offered them. This is that question, in the one place it can be asked
 * without booting a run.
 *
 * The runner's container is added to the same context, so the suite reaches the
 * image through the transport `bash` already uses.
 *
 * @category constructors
 * @since 0.1.0
 */
export const testFlows = (
  services: Context.Context<KernelChildProcessSpawner.ChildProcessSpawner | Path.Path>,
  container: Container.Container,
  runner: TestRunner.Runner | undefined
): ReadonlyArray<FlowBinding.Source> =>
  runner === undefined ? [] : [
    StandardFlows.tests(
      Context.add(
        Context.add(services, TestRunner.TestRunner, TestRunner.make(runner)),
        Container.Container,
        container
      )
    )
  ]

/**
 * A replaceable HTTP transport over Undici, given a way to acquire a dispatcher.
 *
 * `RequestExecutor` asks a host for two things: the client to use now, and an
 * effect that builds another. A retry ladder repairs a failure by
 * waiting and a destroyed HTTP/2 session is the failure waiting does not
 * repair. Undici's dispatcher *is* the connection pool, so on Node the
 * replacement is a new one.
 *
 * Each dispatcher is acquired in a scope forked off the caller's, and the
 * previous scope is closed the moment the next dispatcher is in hand, so a run
 * that rebuilds many times still holds exactly one pool and the caller's own
 * teardown closes the last of them. The *first* client is built by this same
 * code rather than taken from `NodeHttpClient.layerUndici`, so the client the
 * executor starts on and the client a rebuild produces are made the same way
 * and owned the same way.
 *
 * `acquire` is a parameter so a test can hand it a scripted dispatcher; the
 * production caller passes `NodeHttpClient.makeDispatcher`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const rebuildableTransport = (
  acquire: Effect.Effect<Undici.Dispatcher, never, Scope.Scope>
): Effect.Effect<RequestExecutor.Transport, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const gate = yield* Semaphore.make(1)
    let held: Scope.Closeable | undefined = undefined
    const rebuild = gate.withPermit(Effect.gen(function*() {
      const owned = yield* Scope.fork(scope)
      const client = yield* NodeHttpClient.makeUndici.pipe(
        Effect.provideServiceEffect(NodeHttpClient.Dispatcher, acquire),
        Effect.provideService(Scope.Scope, owned)
      )
      const previous = held
      held = owned
      if (previous !== undefined) yield* Scope.close(previous, Exit.void)
      return client
    }))
    return { client: yield* rebuild, rebuild }
  })

/** The production executor: an Undici agent the run may replace. */
const rebuildableUndici: Effect.Effect<RequestExecutor.RequestExecutor, never, Scope.Scope> = Effect.flatMap(
  rebuildableTransport(NodeHttpClient.makeDispatcher),
  RequestExecutor.makeWith
)

/** The production model transport, replaceable only at the composition boundary. */
const layerRequestExecutor: Layer.Layer<RequestExecutor.RequestExecutor> = Layer.effect(
  RequestExecutor.RequestExecutor,
  rebuildableUndici
)

/**
 * Provides the production run executor: the `@smthrs/agent` composition root
 * over the durable control stores, the local flow registry, and the standard
 * host capabilities: filesystem and shell through the kernel's guarded
 * layers, durable memory over the control database, approval and steering
 * wired back into the control plane by the session itself.
 *
 * The durable engine is built through `@smthrs/flows/NodeRuntime`, whose
 * final registration phase constructs `AgentSession`. This is deliberate:
 * the executor cannot accept a launch until the engine database is migrated,
 * its stores and sweepers are live, and the agent flow body has been
 * registered. The resulting engine state is durable, and no launch can race
 * ahead of that durability-sensitive startup order.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerExecutor = (
  registry: Layer.Layer<Registry.Registry>,
  engine: EngineDurable,
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  /**
   * MCP servers to connect at startup, each projected into the run's flow
   * catalog by `@smthrs/mcp/McpFlows`, one more source alongside filesystem,
   * shell, and memory below. Empty by default: a host that names none behaves
   * exactly as it always has.
   */
  mcpServers: ReadonlyArray<McpClient.ConnectOptions> = [],
  grants: Layer.Layer<GrantStore.GrantStore> = layerGrantStore(root),
  requestExecutor: Layer.Layer<RequestExecutor.RequestExecutor> = layerRequestExecutor,
  quotaPolicy: Layer.Layer<QuotaPolicy.QuotaClassifier> = QuotaPolicy.layerDefault()
): Layer.Layer<
  ControlExecutor.ControlExecutor,
  never,
  ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
> => {
  const workspaceRoot = resolve(root)
  // The same guarded platform the registry discovers under: kernel FileSystem
  // over descriptor-relative atomic access, with the Node service bundle
  // (Path, raw spawner, crypto) merged through. `grants` is passed rather than
  // defaulted so the filesystem and the shell below it can never end up asking
  // two different stores.
  const platform = layerGuardedPlatform(root, grants)
  const guarded = KernelChildProcessSpawner.layer.pipe(
    Layer.provide(grants),
    Layer.provideMerge(platform)
  )
  const memory = MemoryStore.layer.pipe(Layer.provide(engine.stores), Layer.orDie)
  // AgentSession installs the effective budget from the approved card around
  // each `agent.run`. No card exists while this executor layer is built, so
  // unbounded is the only honest construction-time budget. The provider is
  // discarded after it closes `Agent.layer`; every run installs
  // `Budget.layerFromEnvelope` directly around the call. The quota layer is
  // the same policy the session installs for the run.
  const sessionAgent = Agent.layer.pipe(
    // eslint-disable-next-line no-restricted-syntax -- no envelope exists until AgentSession starts a run
    Layer.provide(Layer.mergeAll(quotaPolicy, Budget.layerUnbounded()))
  )
  // The dispatcher must live as long as the executor. A model captures this
  // service and uses it after seat resolution has returned.
  //
  // It also has to be replaceable. A retry ladder repairs a failure by waiting,
  // and an HTTP/2 session the peer has destroyed is the failure waiting does not
  // repair: every attempt that reuses the pool holding it fails identically, and
  // r92 of the SWE-bench full benchmark spent ten `transport` retries and $0.85
  // proving it on two instances. Undici's `Agent` *is* the pool, and
  // `makeDispatcher` acquires a fresh one, so the honest rebuild here is a new
  // agent in a scope of its own. The previous one is closed as soon as the new
  // one is in hand, so a run that rebuilds many times still holds one pool.
  const registration = Layer.effect(ControlExecutor.ControlExecutor)(
    Effect.gen(function*() {
      const filesystemServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const shellServices = yield* Effect.context<
        KernelChildProcessSpawner.ChildProcessSpawner | Path.Path
      >()
      const memoryServices = yield* Effect.context<MemoryStore.MemoryStore | Recall.Recall>()
      const nativeSearch = NativeSearch.make(Context.merge(filesystemServices, shellServices))
      // `test` is offered exactly when this host can say how the repository
      // runs its tests. The declaration carries the container too, so the
      // runner reaches the same transport `bash` does.
      const runner = testRunner(environment, root)
      const container = Container.makeCommand()
      // Each configured server is a startup-time connection the operator
      // opted into by naming it, the same way `memory` below is: a server
      // that fails to spawn dies the executor loudly (`Effect.orDie`) rather
      // than running silently short of the tools it was configured to have.
      const mcp = yield* Effect.forEach(mcpServers, (server) => Effect.orDie(McpFlows.connected(server)))
      return yield* AgentSession.make({
        flows: [
          StandardFlows.filesystem(filesystemServices, nativeSearch),
          StandardFlows.shell(shellServices, container),
          StandardFlows.memory(memoryServices),
          ...testFlows(shellServices, container, runner),
          ...mcp
        ],
        limits: cellLimits,
        quotaPolicy,
        budget: Budget.layerFromEnvelope
      })
    })
  ).pipe(
    Layer.provide([
      guarded,
      memory,
      Recall.layerNoop,
      sessionAgent,
      // The run's mutation accounting is measured rather than declared, and
      // this is what measures it: without an observer in the composition the
      // controller falls back to what a frame's calls claimed about
      // themselves, which is blind to every `bash` write. It runs on the host
      // platform rather than on `platform`, for the reasons `layerObserver`
      // states.
      layerObserver(root),
      // Where a run's checkpoints live. Without it `ctx.checkpoint()` and
      // `ctx.base` answer `checkpoint_unavailable`, honestly, and the run
      // takes its readings on the live tree. This is the difference
      // between a run that can prove fails-before without reverting its own
      // work and one that cannot.
      Checkpoints.layerGit(checkpointStore(environment, root)),
      layerSeatResolver(environment).pipe(Layer.provide(requestExecutor))
    ])
  )
  return NodeFlowsRuntime.layer(
    {
      filename: executionDatabasePath(root),
      workspaceRoot,
      // The machine's own name, for the same reason `engineDurable` stamps
      // it: `sameHostPidProbe` compares `hostId` before it trusts a pid, and
      // a constant made every row in every process table look local. Two
      // checkouts inside one container and the host they are bind-mounted
      // from share this file with disjoint pid namespaces, so under a
      // constant the probe answered about the wrong process table, and a row
      // whose owner was alive elsewhere read as dead here.
      owner: { hostId: hostname() },
      // Two terminals over one project are two engine processes over one
      // `.flows/engine.db`, so "one engine process at a time" was never true
      // and a stub answering `false` let each steal the other's running rows
      // 30 seconds after any heartbeat stall. The probe asks the process
      // table instead, and answers only about this host: a run recorded on
      // another host is left to the lease, which `RunStore.steal` verifies.
      isAlive: Ownership.sameHostPidProbe
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(
    Layer.provide([platform, NodeCrypto.layer, NodeJj.layerAt(workspaceRoot)]),
    // Failure to open or migrate the local execution engine is a startup
    // defect, just like the control database above: no command can execute
    // honestly without this composition.
    Layer.orDie
  )
}

/**
 * Provides the application-selected Control implementation with Node HTTP and
 * WebSocket client transports. Local compositions get the production run
 * executor; remote ones talk to a server that owns its own.
 *
 * @category layers
 * @since 0.1.0
 */
const layerControlFromEngine = (
  applicationConfig: Application.Config,
  registry: Layer.Layer<Registry.Registry>,
  engine: EngineDurable
) => {
  const remote = applicationConfig.remote ?? "http://127.0.0.1"
  const root = applicationConfig.root ?? process.cwd()
  const executor = applicationConfig.remote === undefined
    ? layerExecutor(registry, engine, root, process.env, applicationConfig.mcpServers ?? [])
    : undefined
  return Application.layer(applicationConfig, registry, engine, executor).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      websocketLayer(remote, applicationConfig.credential),
      RpcSerialization.layerNdjson
    ])
  )
}

/**
 * Provides the application-selected Control service over Node transports.
 *
 * Use the optional registry and engine when embedding the CLI in an existing
 * composition. A local engine is materialized once before its runtime,
 * journal, executor, and memory consumers are assembled; startup failures die
 * with the layer. A remote configuration opens no local database and reports
 * transport failures through the control client.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerControl = (
  applicationConfig: Application.Config,
  suppliedRegistry?: Layer.Layer<Registry.Registry> | undefined,
  suppliedEngine?: EngineDurable | undefined
) => {
  const root = applicationConfig.root ?? process.cwd()
  const registry = suppliedRegistry ?? layerRegistry(root)
  const engine = suppliedEngine ?? engineDurable(root, registry)
  if (applicationConfig.remote !== undefined) {
    return layerControlFromEngine(applicationConfig, registry, engine)
  }
  return Layer.unwrap(
    Effect.map(
      materializeEngine(engine),
      (materialized) => layerControlFromEngine(applicationConfig, registry, materialized)
    )
  )
}

const output = Output.make()

/**
 * Provides deterministic rendering and transfers rendered statuses to the
 * Node process exit code.
 *
 * Reach for this layer only at the Node executable boundary. Rendering admits
 * only bounded inert data, and only validated control receipts can set a
 * nonzero process status; a missing service is a composition defect.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerOutput = Layer.succeed(
  Output.Output,
  Output.Output.of({
    render: Effect.fn("Output.render")((value, format) =>
      output.render(value, format).pipe(
        Effect.tap((rendered) =>
          Effect.sync(() => {
            process.exitCode = rendered.exitCode
          })
        )
      )
    )
  })
)

/**
 * Provides the complete Node command-handler environment.
 *
 * This is the production layer for `smthrs`. Local composition acquires one
 * durable engine and shares it across control, execution, memory, and serving;
 * open or migration failures terminate startup. Remote composition builds the
 * RPC client without opening a local control database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (applicationConfig: Application.Config) => {
  const root = applicationConfig.root ?? process.cwd()
  const registry = layerRegistry(root)
  const durable = engineDurable(root, registry)
  // Sampled here, before anything opens the control database. `Project.layer`
  // reads the 0.x markers eagerly when it is called, and opening the control
  // database writes `<root>/.flows`, which is the very absence release policy
  // the 0.x-project guard gates the notice on. Building this inside `compose` therefore
  // sampled a directory the same invocation had already created, and the
  // notice stopped printing on exactly the 0.x projects it exists for.
  const project = Project.layer(root, applicationConfig.migrationRoot ?? Project.legacyRoot(undefined, root))
  const compose = (engine: EngineDurable) => {
    const control = layerControlFromEngine(applicationConfig, registry, engine)
    const gatewayHost = applicationConfig.remote === undefined
      ? Layer.effect(
        Serve.GatewayHost,
        Effect.gen(function*() {
          const controlService = yield* Control.Control
          const journalService = yield* Journal.Journal
          return Serve.GatewayHost.of({
            launch: (health, options, gatewayRoot) =>
              Layer.launch(
                layerGateway(
                  health,
                  options,
                  gatewayRoot,
                  engine,
                  Layer.succeed(Journal.Journal, journalService)
                )
              ).pipe(
                Effect.provideService(Control.Control, controlService),
                Effect.provide(NodeServices.layer),
                Effect.orDie
              )
          })
        })
      ).pipe(Layer.provide([control, engine.journal]))
      : Layer.effect(
        Serve.GatewayHost,
        Effect.map(Control.Control, (controlService) =>
          Serve.GatewayHost.of({
            launch: (health, options, gatewayRoot) =>
              Layer.launch(layerGateway(health, options, gatewayRoot, engine)).pipe(
                Effect.provideService(Control.Control, controlService),
                Effect.provide(NodeServices.layer),
                Effect.orDie
              )
          }))
      ).pipe(Layer.provide(control))
    return Layer.mergeAll(
      control,
      gatewayHost,
      layerOutput,
      NodeServices.layer,
      project,
      // `smthrs memory` reads and writes the same durable store a run's
      // `memory` flow does, over the same control database. A separate
      // connection would be a second writer to one SQLite file. A remote
      // invocation has no local database to be that store, so it gets the
      // refusal instead of silently writing where nothing reads.
      applicationConfig.remote === undefined ? layerMemory(root, engine) : layerMemoryRemote
    )
  }
  return applicationConfig.remote === undefined
    ? Layer.unwrap(Effect.map(materializeEngine(durable), compose))
    : compose(durable)
}

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Refuses a composition root whose allowed requirement channel is not exact. */
type RequirementsAre<L, Expected> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>]
  ? [R] extends [Expected] ? [Expected] extends [R] ? true : false : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/**
 * Pins the executor and both complete control-plane compositions.
 *
 * The executor is installed beneath `Application.layer`, so its control
 * runtime, journal, notification queue, and registry are deliberate inputs.
 * `layerControl` supplies them, and the final command-handler root owes
 * nothing.
 *
 * @category models
 * @since 1.0.0
 */
export type CompositionRootsAreComplete = [
  Expect<
    RequirementsAre<
      ReturnType<typeof layerExecutor>,
      ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
    >
  >,
  Expect<Complete<ReturnType<typeof layerControl>>>,
  Expect<Complete<ReturnType<typeof layer>>>
]

/**
 * Provides the memory store a `--remote` invocation gets: none, said out loud.
 *
 * The control plane owns memory. Building the local store here would open (and
 * create) a `.flows/control.db` beside the operator's shell and write facts the
 * server never reads, which is worse than a refusal because it looks like it
 * worked.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemoryRemote: Layer.Layer<MemoryStore.MemoryStore> = MemoryStore.layerNoop({
  putFact: () => remoteMemory("memory set"),
  getFact: () => remoteMemory("memory get"),
  deleteFact: () => remoteMemory("memory rm"),
  listFacts: () => remoteMemory("memory list")
})

const remoteMemory = (verb: string): Effect.Effect<never, MemoryError.MemoryError> =>
  Effect.fail(
    new MemoryError.MemoryError({
      code: "store",
      message:
        `${verb} is not available against --remote: the control plane owns memory. Run it on the host that holds .flows/control.db.`
    })
  )

/**
 * Provides the durable memory store the `memory` verbs read and write, over
 * the control database.
 *
 * A remote composition has no local database, so the store is the unavailable
 * one there: `smthrs --remote ... memory set` must say the control plane
 * owns memory rather than write a fact into a file the server never reads.
 * Local open and migration failures are startup defects, consistent with the
 * control runtime using the same store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory = (
  root: string,
  engine: EngineDurable = engineDurable(root)
): Layer.Layer<MemoryStore.MemoryStore> =>
  MemoryStore.layer.pipe(
    Layer.provide([engine.stores, NodeCrypto.layer]),
    Layer.orDie
  )

const defaultServerOptions: ServerOptions = { host: "127.0.0.1", port: 3000 }

const listenOptions = (options: ServerOptions): ListenOptions => {
  const { listen, ...nodeOptions } = options
  const host = nodeOptions.host ?? "127.0.0.1"
  if (!Serve.isLoopback(host) && listen !== true) {
    throw new Error(`Refusing non-loopback control bind ${host} without an explicit --listen opt-in`)
  }
  return { ...nodeOptions, host }
}

/**
 * Hosts the abstract Control HTTP/WebSocket router on a scoped Node HTTP
 * server. The returned layer retains the concrete HttpServer service so
 * callers can inspect an ephemeral address.
 *
 * Use this with an explicit authentication layer. Non-loopback hosts without
 * `listen: true` are rejected synchronously, and socket failures remain in the
 * returned server layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServer = (
  auth: Layer.Layer<ControlRpcs.ControlAuth>,
  options: ServerOptions = defaultServerOptions
) =>
  HttpRouter.serve(
    ControlServer.layerHttp.pipe(
      Layer.provide(auth),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    {
      disableListenLog: true,
      disableLogger: true
    }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, listenOptions(options)))
  )

/**
 * Hosts the whole workspace gateway: the control plane, the served
 * projections, the journal read path, and the health probe, on one socket.
 *
 * `@smthrs/gateway` owns the assembly (`GatewayServer.layer`) and its Node
 * host (`NodeGateway.layer`); this function supplies the four services those
 * mounts read through that only a project on disk can provide. `Control` stays
 * a requirement, so the verb hosts the same control plane its own commands
 * talk to rather than opening a second one.
 *
 * The sync read path receives the already-open journal when this is composed
 * by {@link layer}. Standalone callers may omit it and let one durable engine
 * provide the journal. A second `ControlLive` is never constructed.
 *
 * `RunCatalog` and `WorkspaceShare` are the no-op implementations: a local
 * gateway shares nothing and publishes no catalog, and the relay
 * implementations belong to a host that has an account to publish under.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerGateway = (
  health: GatewayServer.Health,
  options: NodeGateway.ServerOptions = { host: "127.0.0.1", port: defaultServerOptions.port },
  root: string,
  engine: EngineDurable = engineDurable(root),
  journal: Layer.Layer<Journal.Journal> = engine.journal
) => {
  const host = options.host ?? "127.0.0.1"
  if (!Serve.isLoopback(host) && options.listen !== true) {
    throw new Error(`Refusing non-loopback gateway bind ${host} without an explicit --listen opt-in`)
  }
  const gateway = NodeGateway.layer(health, options).pipe(
    Layer.provide([
      GatewayProjections.layer,
      SyncServer.layer.pipe(Layer.provide([journal, RunCatalog.layerNoop])),
      SyncAuth.layer.pipe(Layer.provide(WorkspaceShare.layerNoop))
    ])
  )
  // Those three supplied layers discharge every gateway input except Control.
  // Some upstream layer combinators currently widen that input to `any`, which
  // would make every caller look incomplete even though the runtime graph is
  // closed. Preserve the exact boundary this composition actually exposes.
  return gateway
}

/**
 * Hosts Control using the alpha's single shared bearer token.
 *
 * Use this at an authenticated bind boundary. It inherits {@link layerServer}
 * failures, including the refusal of a non-loopback host without `listen`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerBearerAuth = (
  auth: ControlRpcs.BearerAuthOptions,
  options: ServerOptions = defaultServerOptions
) => layerServer(ControlRpcs.layerBearerAuth(auth), options)

/**
 * Hosts Control with permissive authentication for trusted local and test use.
 * Production hosts must call `layerServer` with an explicit authentication
 * layer.
 *
 * Any non-loopback host is rejected synchronously, even when `listen` is true;
 * loopback socket failures remain in the returned server layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerNoopAuth = (options: ServerOptions = defaultServerOptions) => {
  const host = options.host ?? "127.0.0.1"
  if (!Serve.isLoopback(host)) {
    throw new Error(`Refusing non-loopback control bind ${host} with permissive authentication`)
  }
  // The loopback refusal three lines up is the whole guard: this
  // composition cannot be built for a bind anything off this machine can
  // reach. `listen: false` keeps it in-process on top of that.
  // eslint-disable-next-line no-restricted-syntax -- guarded by the refusal above
  return layerServer(ControlRpcs.layerNoopAuth(), { ...options, listen: false })
}

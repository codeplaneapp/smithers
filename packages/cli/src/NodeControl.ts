/**
 * Node transport composition for the Control service.
 *
 * @since 0.1.0
 */
import { NodeCrypto, NodeHttpClient, NodeHttpServer, NodeServices, NodeSocket } from "@effect/platform-node"
import type * as Undici from "@effect/platform-node/Undici"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import {
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
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Migrations, SqlJournal } from "@smthrs/journal"
import type * as Journal from "@smthrs/journal/Journal"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import type * as McpClient from "@smthrs/mcp/McpClient"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import type * as ModelError from "@smthrs/model/ModelError"
import * as OpenAIChatGPT from "@smthrs/model/OpenAIChatGPT"
import * as OpenAICompatible from "@smthrs/model/OpenAICompatible"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import type { NotificationQueue } from "@smthrs/notifications"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Container from "@smthrs/std/Container"
import * as NativeSearch from "@smthrs/std/NativeSearch"
import * as TestRunner from "@smthrs/std/TestRunner"
import type { FileSystem, Path, Result } from "effect"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { ListenOptions } from "node:net"
import { dirname, join } from "node:path"
import * as Application from "./Application.ts"
import * as CodexAuth from "./CodexAuth.ts"
import * as Output from "./Output.ts"

/**
 * The environment subset consulted while resolving Node application
 * configuration.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Environment {
  readonly FLOWS_REMOTE?: string | undefined
  readonly FLOWS_MCP_CONFIG?: string | undefined
}

/**
 * Node HTTP listen options accepted by the control server.
 *
 * @category models
 * @since 0.1.0
 * @slop
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
const isMcpServerEntry = (value: unknown): value is McpClient.ConnectOptions =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly server?: unknown }).server === "string" &&
  typeof (value as { readonly command?: unknown }).command === "string" &&
  Array.isArray((value as { readonly args?: unknown }).args)

/**
 * Reads and validates the MCP servers named by `--mcp-config`/`FLOWS_MCP_CONFIG`.
 *
 * The file is a JSON array of `{server, command, args, cwd?, env?}` entries —
 * exactly `McpClient.ConnectOptions`. A missing path is not configured (no
 * MCP servers, the same as omitting the flag); a present but malformed file
 * is a startup defect, thrown here rather than silently ignored, since a
 * typo'd config should not look like "no MCP servers configured."
 *
 * @category constructors
 * @since 0.1.0
 */
const mcpServersFromArguments = (
  args: ReadonlyArray<string>,
  environment: Environment
): ReadonlyArray<McpClient.ConnectOptions> | undefined => {
  const path = valueFromArguments(args, "mcp-config") ?? environment.FLOWS_MCP_CONFIG
  if (path === undefined) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!Array.isArray(parsed) || !parsed.every(isMcpServerEntry)) {
    throw new Error(
      `--mcp-config ${path} must be a JSON array of { server, command, args, cwd?, env? } entries`
    )
  }
  return parsed
}

/**
 * Resolves application configuration from command arguments with an
 * environment fallback.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeConfig = (
  args: ReadonlyArray<string>,
  environment: Environment = process.env
): Application.Config => ({
  remote: valueFromArguments(args, "remote") ?? environment.FLOWS_REMOTE,
  credential: valueFromArguments(args, "credential"),
  mcpServers: mcpServersFromArguments(args, environment)
})

/**
 * Resolves configuration for the current Node process.
 *
 * @category configuration
 * @since 0.1.0
 * @slop
 */
export const config: Effect.Effect<Application.Config> = Effect.sync(() => makeConfig(process.argv.slice(2)))

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
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const projectSources = (root: string): ReadonlyArray<Descriptor.Source> => [
  { source: "project", root: join(root, "flows"), naming: "path" }
]

/**
 * The raw host platform: Node's own services plus the descriptor-relative,
 * no-follow filesystem the kernel needs underneath it. `NodeServices` alone is
 * not enough — the kernel's guarded `FileSystem` refuses every operation unless
 * the host provides descriptor-relative, no-follow access, which is what
 * `AtomicFileSystem` adds on Node.
 *
 * This is the *unguarded* half of the composition. It is what
 * {@link layerGuardedPlatform} is built on, and it is what host equipment that
 * carries its own confinement argument runs on — today only the workspace
 * observer, whose module documents why (`@smthrs/agent/WorkspaceObservation`).
 * Agent-reachable equipment never gets this layer: a flow, a tool, or anything
 * a model can steer takes {@link layerGuardedPlatform} so the kernel decides
 * what it may touch.
 *
 * One `const`, not a function, so every consumer in one composition shares a
 * single memoized build.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerHostPlatform = Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer)

/**
 * The kernel-guarded platform over one workspace root: every filesystem
 * operation resolved, authorized, re-resolved, and executed relative to a
 * pinned root descriptor.
 *
 * `grants` is the store the kernel asks before it authorizes an operation, and
 * it is a parameter rather than a constant so that one composition cannot end
 * up asking two different stores. The default is the allow-all one because the
 * local CLI is the operator's own process; a hosted composition supplies a real
 * `GrantStore`, and must supply the same one it gives
 * `KernelChildProcessSpawner` — a filesystem pinned to the allow-all store
 * beside a shell pinned to a real one is a fail-open the types would not catch.
 *
 * The confinement the kernel still enforces here is structural — canonical
 * resolution, the hard-link refusal, and descriptor-relative execution from a
 * pinned root — and that is what costs: on Node one authorized operation is one
 * helper process, so a caller that performs one operation per file in a
 * checkout pays for the whole checkout. That is a cost to spend on
 * agent-reachable equipment and to refuse for a whole-tree walk; see
 * {@link layerHostPlatform}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerGuardedPlatform = (
  root: string,
  grants: Layer.Layer<GrantStore.GrantStore> = GrantStore.layerNoop
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
 * {@link layerGuardedPlatform}. The observer is host equipment — the root is
 * this composition's, not a model's — and it carries its own confinement
 * argument: it stats, it never opens, it follows no symlink, and every path it
 * builds is an entry name under the root. `@smthrs/agent/WorkspaceObservation`
 * states that argument in full. Guarding it decides nothing and costs one
 * helper process per file: SWE-bench wave 6 spent 912 s of a 1,200 s budget on
 * django's opening walk and never reached the agent's first tool call.
 *
 * @category layers
 * @since 0.1.0
 * @slop
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
 * startup failure — an unreadable one is, and dies rather than silently
 * discovering nothing.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerRegistry = (root: string = process.cwd()): Layer.Layer<Registry.Registry> => {
  const platform = layerGuardedPlatform(root)
  const discovery = Discovery.layer.pipe(Layer.provide(platform))
  return Registry.layer({ sources: projectSources(root) }).pipe(
    Layer.provide([discovery, platform]),
    // A project with no `flows/` directory simply has no flows. Every other
    // discovery failure — an unreadable root, a malformed entry — is a startup
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
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const databasePath = (root: string): string => join(root, ".flows", "control.db")

/**
 * Where the durable flow engine keeps executions, attempts, cache entries,
 * and wake state. The control plane has a separate connection and schema in
 * {@link databasePath}; keeping the files separate makes each composition's
 * migration ownership explicit.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const executionDatabasePath = (root: string): string => join(root, ".flows", "engine.db")

/**
 * `Application.Engine` plus the shared database seam the Node composition
 * hangs additional stores off — the memory store reuses the same connection
 * the runtime and journal commit against.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface EngineDurable extends Application.Engine {
  readonly stores: Layer.Layer<DurableWriter.DurableWriter | SqlClient>
}

/** The reserved system catalog in the durable runtime's flow shape. */
const systemFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = SystemFlows.catalog.map((entry) => ({
  flowId: entry.flowId,
  description: `Reserved ${entry.verb} system flow`,
  deployClass: entry.deployClass,
  envelope: { capabilities: [], flows: [], budget: {} }
}))

/** Projects one discovered flow into the durable runtime's flow shape. */
const durableFlow = (descriptor: Descriptor.FlowDescriptor): ControlRuntime.MemoryFlow => ({
  flowId: descriptor.name,
  description: descriptor.description,
  deployClass: false,
  envelope: {
    capabilities: descriptor.capabilities,
    flows: descriptor.flows,
    budget: {}
  }
})

/**
 * Provides the durable local engine: `SqlControlRuntime` and the production
 * SQL journal, both over one SQLite file under the project root.
 *
 * The previous local composition was `ControlRuntime.layerMemory()` over
 * `TestJournal` — an in-memory database — so no plan, approval, run, or journal
 * entry survived the process. Sharing one connection between the runtime and
 * the journal is deliberate: the fenced run transitions and the events that
 * describe them then commit against the same database.
 *
 * With a `registry`, the runtime knows every discovered flow as well as the
 * reserved system catalog, so `flows plan <flow>` plans a project flow
 * instead of failing `FlowNotFound`.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const engineDurable = (
  root: string = process.cwd(),
  registry?: Layer.Layer<Registry.Registry> | undefined
): EngineDurable => {
  const file = databasePath(root)
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
    ? SqlControlRuntime.layer().pipe(Layer.provide([stores, NodeCrypto.layer]), Layer.orDie)
    : Layer.effect(ControlRuntime.ControlRuntime)(
      Effect.gen(function*() {
        const registryService = yield* Registry.Registry
        const discovered = yield* registryService.list()
        return yield* SqlControlRuntime.make({ flows: [...systemFlows, ...discovered.map(durableFlow)] })
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
 * lane opts in through the environment without respelling any seat — the
 * journaled seat, its context window, and its committed price stay identical.
 */
const openaiAuthVariable = "FLOWS_OPENAI_AUTH"

/**
 * The Node seat resolver: it turns a `provider:modelId` seat into a live model
 * route, with the API key read from the given environment — usually
 * `process.env`, passed in as a value so nothing below this composition touches
 * the process directly.
 *
 * A seat with no separator is a bare model id on the Anthropic route, which is
 * the one provider convention this host assumes.
 *
 * `FLOWS_OPENAI_AUTH=chatgpt` swaps the `openai` provider's credential source
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
        const variable = apiKeyVariable[provider]
        if (variable === undefined) {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `No route is configured for the ${provider} provider`
          })
        }
        // An empty value is treated exactly like an unset variable, the same
        // convention the key variables follow below.
        const configured = environment[openaiAuthVariable]
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
            OpenAICompatible.make({
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
  environment: Readonly<Record<string, string | undefined>> = process.env
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
 * the only field that decides anything is the command — the rest describe where
 * that command runs.
 *
 * `undefined` means this host knows of no runner, and then the `test` flow is
 * not bound at all. That is the rule the r91 wave broke in the other direction:
 * `StandardFlows.tests` existed, the cell contract's doctrine assumed it, and
 * no composition offered it, so all 45 graded runs saw zero `test` calls. A
 * flow no composition offers is a flow that does not exist — and a flow bound
 * over a declaration that can only refuse is worse, because the catalog then
 * advertises a call whose every answer is "not configured".
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const testRunner = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string
): TestRunner.Runner | undefined => {
  const command = environment["FLOWS_TEST_COMMAND"]?.trim()
  if (command === undefined || command === "") return undefined
  const container = environment["FLOWS_TEST_CONTAINER"]?.trim()
  const cwd = environment["FLOWS_TEST_CWD"]?.trim()
  const timeout = Number(environment["FLOWS_TEST_TIMEOUT_MS"])
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
 * `FLOWS_TEST_CWD` is the container's name for the repository when there is
 * one, and the workspace root is the host's — so a host that declares neither
 * still pins, and pins on one path under both names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkpointStore = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string
): Checkpoints.GitOptions => {
  const cwd = environment["FLOWS_TEST_CWD"]?.trim()
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
 * @slop
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
 * `RequestExecutor` asks a host for two things — the client to use now, and an
 * effect that builds another — because a retry ladder repairs a failure by
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
    let held: Scope.Closeable | undefined = undefined
    const rebuild = Effect.gen(function*() {
      const owned = yield* Scope.fork(scope)
      const client = yield* NodeHttpClient.makeUndici.pipe(
        Effect.provideServiceEffect(NodeHttpClient.Dispatcher, acquire),
        Effect.provideService(Scope.Scope, owned)
      )
      const previous = held
      held = owned
      if (previous !== undefined) yield* Scope.close(previous, Exit.void)
      return client
    })
    return { client: yield* rebuild, rebuild }
  })

/** The production executor: an Undici agent the run may replace. */
const rebuildableUndici: Effect.Effect<RequestExecutor.RequestExecutor, never, Scope.Scope> = Effect.flatMap(
  rebuildableTransport(NodeHttpClient.makeDispatcher),
  RequestExecutor.makeWith
)

/**
 * Provides the production run executor: the `@smthrs/agent` composition root
 * over the durable control stores, the local flow registry, and the standard
 * host capabilities — filesystem and shell through the kernel's guarded
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
 * @slop
 */
export const layerExecutor = (
  registry: Layer.Layer<Registry.Registry>,
  engine: EngineDurable,
  root: string = process.cwd(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  /**
   * MCP servers to connect at startup, each projected into the run's flow
   * catalog by `@smthrs/mcp/McpFlows` — one more source alongside filesystem,
   * shell, and memory below. Empty by default: a host that names none behaves
   * exactly as it always has.
   */
  mcpServers: ReadonlyArray<McpClient.ConnectOptions> = []
): Layer.Layer<
  ControlExecutor.ControlExecutor,
  never,
  ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
> => {
  const grants = GrantStore.layerNoop
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
  // The dispatcher must live as long as the executor. A model captures this
  // service and uses it after seat resolution has returned.
  //
  // It also has to be replaceable. A retry ladder repairs a failure by waiting,
  // and an HTTP/2 session the peer has destroyed is the failure waiting does not
  // repair: every attempt that reuses the pool holding it fails identically, and
  // r92 of the SWE-bench full benchmark spent ten `transport` retries and $0.85
  // proving it on two instances. Undici's `Agent` *is* the pool, and
  // `makeDispatcher` acquires a fresh one, so the honest rebuild here is a new
  // agent in a scope of its own — the previous one is closed as soon as the new
  // one is in hand, so a run that rebuilds many times still holds one pool.
  const dispatcher = Layer.effect(RequestExecutor.RequestExecutor)(rebuildableUndici)
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
        limits: cellLimits
      })
    })
  ).pipe(
    Layer.provide([
      guarded,
      memory,
      Recall.layerNoop,
      Agent.layer,
      // The run's mutation accounting is measured rather than declared, and
      // this is what measures it: without an observer in the composition the
      // controller falls back to what a frame's calls claimed about
      // themselves, which is blind to every `bash` write. It runs on the host
      // platform rather than on `platform`, for the reasons `layerObserver`
      // states.
      layerObserver(root),
      // Where a run's checkpoints live. Without it `ctx.checkpoint()` and
      // `ctx.base` answer `checkpoint_unavailable` — honestly, and the run
      // takes its readings on the live tree — so this is the difference
      // between a run that can prove fails-before without reverting its own
      // work and one that cannot.
      Checkpoints.layerGit(checkpointStore(environment, root)),
      layerSeatResolver(environment).pipe(Layer.provide(dispatcher))
    ])
  )
  return NodeFlowsRuntime.layer(
    {
      filename: executionDatabasePath(root),
      owner: { hostId: "flows-cli" },
      // The local CLI has one engine process at a time. A later supervised or
      // multi-process host must replace this with a real liveness answer.
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(
    Layer.provide([platform, NodeCrypto.layer, NodeJj.layer]),
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
 * @slop
 */
export const layerControl = (applicationConfig: Application.Config) => {
  const remote = applicationConfig.remote ?? "http://127.0.0.1"
  const registry = layerRegistry()
  const engine = engineDurable(process.cwd(), registry)
  const executor = applicationConfig.remote === undefined
    ? layerExecutor(registry, engine, process.cwd(), process.env, applicationConfig.mcpServers ?? [])
    : undefined
  return Application.layer(applicationConfig, registry, engine, executor).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      websocketLayer(remote, applicationConfig.credential),
      RpcSerialization.layerNdjson
    ])
  )
}

const output = Output.make()

/**
 * Provides deterministic rendering and transfers rendered statuses to the
 * Node process exit code.
 *
 * @category layers
 * @since 0.1.0
 * @slop
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
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (applicationConfig: Application.Config) =>
  Layer.mergeAll(layerControl(applicationConfig), layerOutput, NodeServices.layer)

const defaultServerOptions: ServerOptions = { host: "127.0.0.1", port: 3000 }

const isLoopbackHost = (host: string): boolean => host === "127.0.0.1" || host === "::1"

const listenOptions = (options: ServerOptions): ListenOptions => {
  const { listen, ...nodeOptions } = options
  const host = nodeOptions.host ?? "127.0.0.1"
  if (!isLoopbackHost(host) && listen !== true) {
    throw new Error(`Refusing non-loopback control bind ${host} without an explicit --listen opt-in`)
  }
  return { ...nodeOptions, host }
}

/**
 * Hosts the abstract Control HTTP/WebSocket router on a scoped Node HTTP
 * server. The returned layer retains the concrete HttpServer service so
 * callers can inspect an ephemeral address.
 *
 * @category layers
 * @since 0.1.0
 * @slop
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
 * Hosts Control using the alpha's single shared bearer token.
 *
 * @category layers
 * @since 0.1.0
 * @slop
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
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerServerNoopAuth = (options: ServerOptions = defaultServerOptions) => {
  const host = options.host ?? "127.0.0.1"
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing non-loopback control bind ${host} with permissive authentication`)
  }
  return layerServer(ControlRpcs.layerNoopAuth(), { ...options, listen: false })
}

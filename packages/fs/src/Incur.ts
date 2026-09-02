/**
 * Incur projection of executable, model-visible module routes.
 *
 * @since 0.1.0
 */
import type * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Cli as IncurCli } from "incur"
import * as CommandTree from "./CommandTree.ts"
import * as FlowInvoker from "./FlowInvoker.ts"
import type { FsError } from "./FsError.ts"
import * as SchemaBridge from "./internal/SchemaBridge.ts"
import * as Route from "./Route.ts"

type IncurContext = {
  readonly args: Readonly<Record<string, unknown>>
  readonly error: (options: {
    readonly code: string
    readonly exitCode?: number | undefined
    readonly message: string
  }) => never
  readonly ok: (data: unknown) => never
  readonly options: Readonly<Record<string, unknown>>
  readonly request?: Request | undefined
}

type SelectedRoute = {
  readonly route: Route.Route
  readonly flow: Flow.Any
  readonly schema: SchemaBridge.CommandSchema
}

const discoveryFlags = new Set(["--help", "-h", "--llms", "--llms-full", "--schema", "--version"])

const isDiscovery = (argv: ReadonlyArray<string>): boolean =>
  process.env.COMPLETE !== undefined || argv.includes("--mcp") || argv.some((token) => discoveryFlags.has(token))

const isFetchDiscovery = (pathname: string): boolean =>
  pathname === "/mcp" || pathname === "/openapi.json" || pathname === "/openapi.yml" ||
  pathname === "/openapi.yaml" || pathname.startsWith("/.well-known/")

const descriptionOf = (route: Route.Route): string | undefined => Option.getOrUndefined(route.description)

const normalizeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = argv[0]
  return first === undefined || !first.includes("/")
    ? argv
    : Object.freeze([...first.split("/"), ...argv.slice(1)])
}

const commandTokens = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  for (const token of normalizeArgv(argv)) {
    if (token.startsWith("-")) break
    tokens.push(token)
  }
  return Object.freeze(tokens)
}

const runOptions = (request: Request | undefined): { readonly signal: AbortSignal } | undefined =>
  request === undefined ? undefined : { signal: request.signal }

const mapError = (context: IncurContext, error: FsError): never =>
  context.error({ code: error.code, exitCode: 1, message: error.description })

const execute = (
  selected: SelectedRoute,
  context: IncurContext
): Effect.Effect<unknown, never, FlowInvoker.FlowInvoker> =>
  Effect.gen(function*() {
    const input = yield* selected.schema.decode(selected.schema.assemble(context.args, context.options))
    const invoker = yield* Effect.service(FlowInvoker.FlowInvoker)
    const output = yield* invoker.invoke(Object.freeze({
      name: selected.route.name,
      flow: selected.flow,
      input
    }))
    return yield* SchemaBridge.encodeOutput(selected.flow.output, output)
  }).pipe(
    Effect.match({
      onFailure: (error) => mapError(context, error),
      onSuccess: (output) => context.ok(output)
    })
  )

const metadataDefinition = (
  route: Route.Route,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
    options?: { readonly signal: AbortSignal } | undefined
  ) => Promise<A>
) => ({
  description: descriptionOf(route),
  /* v8 ignore next -- the public serve/fetch wrappers hydrate and replace a selected definition before Incur may run it */
  run(context: IncurContext) {
    return runEffect(
      Effect.gen(function*() {
        const flow = yield* Route.load(route)
        const schema = yield* SchemaBridge.toCommandSchema(route.input, flow.input)
        return yield* execute({ route, flow, schema }, context)
      }),
      runOptions(context.request)
    )
  }
})

const selectedDefinition = (
  selected: SelectedRoute,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
    options?: { readonly signal: AbortSignal } | undefined
  ) => Promise<A>
) => ({
  args: selected.schema.args,
  description: descriptionOf(selected.route),
  options: selected.schema.options,
  run(context: IncurContext) {
    return runEffect(execute(selected, context), runOptions(context.request))
  }
})

const buildCli = (
  name: string,
  tree: CommandTree.CommandTree,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
    options?: { readonly signal: AbortSignal } | undefined
  ) => Promise<A>,
  selected?: SelectedRoute
): IncurCli.Cli => {
  const cli = IncurCli.create(name)
  const mountChildren = (parent: IncurCli.Cli, node: CommandTree.CommandTree): void => {
    for (const [segment, child] of node.children) {
      const route = Option.getOrUndefined(child.route)
      const selectedHere = route !== undefined && selected?.route === route
      if (child.children.size > 0 && !selectedHere) {
        const group = IncurCli.create(segment, {
          description: route === undefined ? undefined : descriptionOf(route)
        })
        mountChildren(group, child)
        parent.command(group)
      } else {
        // A trie node without children is always the leaf of a route; a node
        // with children reaches this arm only when its own route was selected.
        const commandRoute = route!
        parent.command(
          segment,
          selectedHere && selected !== undefined
            ? selectedDefinition(selected, runEffect)
            : metadataDefinition(commandRoute, runEffect)
        )
      }
    }
  }
  mountChildren(cli, tree)
  return cli
}

const hydrate = (
  tree: CommandTree.CommandTree,
  argv: ReadonlyArray<string>
): Effect.Effect<SelectedRoute, FsError> =>
  Effect.gen(function*() {
    const resolved = yield* CommandTree.resolve(tree, commandTokens(argv))
    const flow = yield* Route.load(resolved.route)
    const schema = yield* SchemaBridge.toCommandSchema(resolved.route.input, flow.input)
    return Object.freeze({ route: resolved.route, flow, schema })
  })

/**
 * Projects routes onto an Incur CLI while preserving metadata-only discovery.
 *
 * Only an invoked module is loaded. Its actual Effect input schema is then
 * projected into Incur flags and remains the authoritative decoder.
 *
 * @category constructors
 * @since 0.1.0
 */
export const createCli = (
  name: string,
  routes: ReadonlyArray<Route.Route>
): Effect.Effect<IncurCli.Cli, FsError, FlowInvoker.FlowInvoker> =>
  Effect.gen(function*() {
    const validated = yield* CommandTree.make(routes)
    const executable = CommandTree.traverse(validated).filter(Route.isCommandRoute)
    const tree = yield* CommandTree.make(executable)
    const services = yield* Effect.context<FlowInvoker.FlowInvoker>()
    const runEffect = Effect.runPromiseWith(services)
    const cli = buildCli(name, tree, runEffect)
    const metadataServe = cli.serve.bind(cli)
    const metadataFetch = cli.fetch.bind(cli)

    cli.serve = async (argv = process.argv.slice(2), options = {}) => {
      if (isDiscovery(argv)) return metadataServe(argv, options)
      const normalized = normalizeArgv(argv)
      const selected = await runEffect(Effect.option(hydrate(tree, normalized)))
      return Option.isNone(selected)
        ? metadataServe([...normalized], options)
        : buildCli(name, tree, runEffect, selected.value).serve([...normalized], options)
    }

    cli.fetch = async (request) => {
      const url = new URL(request.url)
      if (isFetchDiscovery(url.pathname)) return metadataFetch(request)
      const selected = await runEffect(
        Effect.option(hydrate(tree, url.pathname.split("/").filter(Boolean))),
        { signal: request.signal }
      )
      return Option.isNone(selected)
        ? metadataFetch(request)
        : buildCli(name, tree, runEffect, selected.value).fetch(request)
    }

    return cli
  })

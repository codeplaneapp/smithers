/**
 * Incur projection of a file-routed flows command tree.
 *
 * @since 0.0.0
 */
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
  readonly schema: SchemaBridge.CommandSchema
}

const discoveryFlags = new Set([
  "--help",
  "-h",
  "--llms",
  "--llms-full",
  "--schema",
  "--version"
])

const isDiscovery = (argv: ReadonlyArray<string>): boolean =>
  process.env.COMPLETE !== undefined ||
  argv.includes("--mcp") ||
  argv.some((token) => discoveryFlags.has(token))

const isFetchDiscovery = (pathname: string): boolean =>
  pathname === "/mcp" ||
  pathname === "/openapi.json" ||
  pathname === "/openapi.yml" ||
  pathname === "/openapi.yaml" ||
  pathname.startsWith("/.well-known/")

const descriptionOf = (route: Route.Route): string | undefined => Option.getOrUndefined(route.description)

const commandTokens = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  for (const token of argv) {
    if (token.startsWith("-")) {
      break
    }
    tokens.push(token)
  }
  return tokens
}

const runOptions = (
  request: Request | undefined
): { readonly signal: AbortSignal } | undefined => request === undefined ? undefined : { signal: request.signal }

const mapError = (
  context: IncurContext,
  error: FsError
): never =>
  context.error({
    code: error.code,
    exitCode: 1,
    message: error.description
  })

const execute = (
  selected: SelectedRoute,
  context: IncurContext
): Effect.Effect<unknown, never, FlowInvoker.FlowInvoker> =>
  Effect.gen(function*() {
    const flow = yield* Route.load(selected.route)
    const assembled = selected.schema.assemble(context.args, context.options)
    const input = yield* selected.schema.decode(assembled)
    const invoker = yield* Effect.service(FlowInvoker.FlowInvoker)
    const output = yield* invoker.invoke({
      name: selected.route.name,
      flow,
      input
    })
    return yield* SchemaBridge.encodeOutput(flow.output, output)
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
  run(context: IncurContext) {
    return runEffect(
      Effect.flatMap(
        SchemaBridge.toCommandSchema(route.input),
        (schema) => execute({ route, schema }, context)
      ),
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
  const rootRoute = Option.getOrUndefined(tree.route)
  const rootDefinition = rootRoute === undefined
    ? undefined
    : selected?.route === rootRoute
    ? selectedDefinition(selected, runEffect)
    : metadataDefinition(rootRoute, runEffect)
  const cli = rootDefinition === undefined
    ? IncurCli.create(name)
    : IncurCli.create(name, rootDefinition)

  const mountChildren = (
    parent: IncurCli.Cli,
    node: CommandTree.CommandTree
  ): void => {
    for (const [segment, child] of node.children) {
      const route = Option.getOrUndefined(child.route)
      const selectedHere = route !== undefined && selected?.route === route
      if (child.children.size > 0 && !selectedHere) {
        const group = IncurCli.create(segment, {
          description: route === undefined ? undefined : descriptionOf(route)
        })
        mountChildren(group, child)
        parent.command(group)
      } else if (route !== undefined) {
        parent.command(
          segment,
          selected !== undefined && selected.route === route
            ? selectedDefinition(selected, runEffect)
            : metadataDefinition(route, runEffect)
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
    const schema = yield* SchemaBridge.toCommandSchema(resolved.route.input)
    return { route: resolved.route, schema }
  })

/**
 * Projects routes onto an incur CLI while preserving metadata-only discovery
 * and loading a flow module only when its route is executed.
 *
 * The returned CLI captures the current `FlowInvoker` service so incur's
 * Promise handlers re-enter the same Effect context at the boundary.
 *
 * TODO(/cli): mount this projection from the effect/unstable/cli based
 * package once that package owns the application entrypoint.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const createCli = (
  name: string,
  routes: ReadonlyArray<Route.Route>
): Effect.Effect<IncurCli.Cli, FsError, FlowInvoker.FlowInvoker> =>
  Effect.gen(function*() {
    const tree = yield* CommandTree.make(routes)
    const services = yield* Effect.context<FlowInvoker.FlowInvoker>()
    const runEffect = Effect.runPromiseWith(services)
    const cli = buildCli(name, tree, runEffect)
    const metadataServe = cli.serve.bind(cli)
    const metadataFetch = cli.fetch.bind(cli)

    cli.serve = async (argv = process.argv.slice(2), options = {}) => {
      if (isDiscovery(argv)) {
        return metadataServe(argv, options)
      }
      const selected = await runEffect(
        Effect.option(hydrate(tree, argv))
      )
      if (Option.isNone(selected)) {
        return metadataServe(argv, options)
      }
      return buildCli(name, tree, runEffect, selected.value).serve(argv, options)
    }

    cli.fetch = async (request) => {
      const url = new URL(request.url)
      if (isFetchDiscovery(url.pathname)) {
        return metadataFetch(request)
      }
      const selected = await runEffect(
        Effect.option(hydrate(tree, url.pathname.split("/").filter(Boolean))),
        { signal: request.signal }
      )
      if (Option.isNone(selected)) {
        return metadataFetch(request)
      }
      return buildCli(name, tree, runEffect, selected.value).fetch(request)
    }

    return cli
  })

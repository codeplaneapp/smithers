/**
 * Agent-facing projection of executable, model-visible module routes.
 *
 * @since 0.1.0
 */
import type * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as CommandTree from "./CommandTree.ts"
import * as FlowInvoker from "./FlowInvoker.ts"
import type { FsError } from "./FsError.ts"
import * as CommandLine from "./internal/CommandLine.ts"
import * as SchemaBridge from "./internal/SchemaBridge.ts"
import * as Route from "./Route.ts"

/**
 * A route advertised to an agent.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListedCommand {
  readonly name: string
  readonly description: string | undefined
}

/**
 * A decoded command-string invocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface ParsedCommand<A = unknown> {
  readonly route: Route.Route
  readonly argv: ReadonlyArray<string>
  readonly input: A
}

/**
 * Runtime projection of a route manifest for agent use.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSurface {
  /** Lists executable model-visible module routes without loading them. */
  readonly list: () => ReadonlyArray<ListedCommand>
  /** Loads the selected module and schema-decodes an agent command string. */
  readonly parse: (commandString: string) => Effect.Effect<ParsedCommand, FsError>
  /** Parses, invokes, and output-encodes an agent command string. */
  readonly execute: (commandString: string) => Effect.Effect<unknown, FsError, FlowInvoker.FlowInvoker>
  /** Loads and invokes an exact named route using snapshotted input. */
  readonly call: <N extends Route.Name>(
    name: N,
    input: Route.Input<N>
  ) => Effect.Effect<Route.Output<N>, FsError, FlowInvoker.FlowInvoker>
}

interface Prepared {
  readonly route: Route.Route
  readonly flow: Flow.Any
  readonly argv: ReadonlyArray<string>
  readonly input: unknown
}

const descriptionOf = (route: Route.Route): string | undefined => Option.getOrUndefined(route.description)

const routeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const first = argv[0]
  if (first === undefined || !first.includes("/")) return argv
  return Object.freeze([...first.split("/"), ...argv.slice(1)])
}

/**
 * Constructs a command surface from routes.
 *
 * Non-module, hidden, and non-model-invocable routes remain available from the
 * registry but never enter this executable projection.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (routes: ReadonlyArray<Route.Route>): Effect.Effect<CommandSurface, FsError> =>
  Effect.gen(function*() {
    const validated = yield* CommandTree.make(routes)
    const commandRoutes = CommandTree.traverse(validated).filter(Route.isCommandRoute)
    const tree = yield* CommandTree.make(commandRoutes)

    const prepare = (commandString: string): Effect.Effect<Prepared, FsError> =>
      Effect.gen(function*() {
        const argv = yield* CommandLine.lex(commandString)
        const resolved = yield* CommandTree.resolve(tree, routeArgv(argv))
        const flow = yield* Route.load(resolved.route)
        const schema = yield* SchemaBridge.toCommandSchema(resolved.route.input, flow.input)
        const parsed = yield* CommandLine.parseFlags(resolved.rest)
        const input = yield* schema.decode(schema.assemble(parsed.args, parsed.options))
        return Object.freeze({ route: resolved.route, flow, argv, input })
      })

    const invoke = (
      route: Route.Route,
      flow: Flow.Any,
      input: unknown
    ): Effect.Effect<unknown, FsError, FlowInvoker.FlowInvoker> =>
      Effect.gen(function*() {
        const invoker = yield* Effect.service(FlowInvoker.FlowInvoker)
        const output = yield* invoker.invoke(Object.freeze({ name: route.name, flow, input }))
        return yield* SchemaBridge.encodeOutput(flow.output, output)
      })

    const listed = Object.freeze(
      CommandTree.traverse(tree).map((route) =>
        Object.freeze({
          name: route.name,
          description: descriptionOf(route)
        })
      )
    )

    const call: CommandSurface["call"] = Effect.fn("Command.call")(
      <N extends Route.Name>(name: N, candidate: Route.Input<N>): Effect.Effect<
        Route.Output<N>,
        FsError,
        FlowInvoker.FlowInvoker
      > =>
        Effect.gen(function*() {
          const input = yield* SchemaBridge.snapshotInput(candidate)
          const segments = typeof name === "string" ? name.split("/") : []
          const route = yield* CommandTree.resolveExact(tree, segments)
          const flow = yield* Route.load(route)
          const decoded = yield* SchemaBridge.decodeInput(flow.input, input)
          return yield* (invoke(route, flow, decoded) as Effect.Effect<
            Route.Output<N>,
            FsError,
            FlowInvoker.FlowInvoker
          >)
        })
    )

    return Object.freeze({
      list: () => listed,
      parse: (commandString: string) =>
        Effect.map(prepare(commandString), ({ argv, input, route }) => Object.freeze({ route, argv, input })),
      execute: Effect.fn("Command.execute")((commandString) =>
        Effect.flatMap(prepare(commandString), ({ flow, input, route }) => invoke(route, flow, input))
      ),
      call
    })
  })

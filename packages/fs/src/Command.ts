/**
 * Agent-facing projection of a flows command tree.
 *
 * @since 0.0.0
 */
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
 * @since 0.0.0
 * @slop
 */
export interface ListedCommand {
  readonly name: string
  readonly description: string | undefined
}

/**
 * A decoded command-string invocation.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface ParsedCommand<A = unknown> {
  readonly route: Route.Route
  readonly argv: ReadonlyArray<string>
  readonly input: A
}

/**
 * The runtime projection of a route manifest for agent use.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface CommandSurface {
  /** Lists routes without loading their modules. */
  readonly list: () => ReadonlyArray<ListedCommand>
  /** Parses and schema-decodes an agent command string. */
  readonly parse: (commandString: string) => Effect.Effect<ParsedCommand, FsError>
  /** Parses, loads, and invokes an agent command string. */
  readonly execute: (commandString: string) => Effect.Effect<unknown, FsError, FlowInvoker.FlowInvoker>
  /** Loads and invokes a route using already-decoded programmatic input. */
  readonly call: <N extends Route.Name>(
    name: N,
    input: Route.Input<N>
  ) => Effect.Effect<Route.Output<N>, FsError, FlowInvoker.FlowInvoker>
}

const descriptionOf = (route: Route.Route): string | undefined => Option.getOrUndefined(route.description)

/**
 * Constructs an agent command surface from routes, building the command tree
 * once while keeping flow materialization lazy.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const make = (
  routes: ReadonlyArray<Route.Route>
): Effect.Effect<CommandSurface, FsError> =>
  Effect.map(CommandTree.make(routes), (tree) => {
    const invoke = (route: Route.Route, input: unknown): Effect.Effect<unknown, FsError, FlowInvoker.FlowInvoker> =>
      Effect.gen(function*() {
        const flow = yield* Route.load(route)
        const invoker = yield* Effect.service(FlowInvoker.FlowInvoker)
        return yield* invoker.invoke({ name: route.name, flow, input })
      })

    const parse = (commandString: string): Effect.Effect<ParsedCommand, FsError> =>
      Effect.gen(function*() {
        const argv = yield* CommandLine.lex(commandString)
        const resolved = yield* CommandTree.resolve(tree, argv)
        const schema = yield* SchemaBridge.toCommandSchema(resolved.route.input)
        const parsed = CommandLine.parseFlags(resolved.rest)
        const assembled = schema.assemble(parsed.args, parsed.options)
        const input = yield* schema.decode(assembled)
        return { route: resolved.route, argv, input }
      })

    return {
      list: () =>
        CommandTree.traverse(tree).map((route) => ({
          name: route.name,
          description: descriptionOf(route)
        })),
      parse,
      execute: Effect.fn("Command.execute")((commandString) =>
        Effect.flatMap(parse(commandString), ({ route, input }) => invoke(route, input))
      ),
      call: Effect.fn("Command.call")(<N extends Route.Name>(name: N, input: Route.Input<N>) =>
        Effect.flatMap(
          CommandTree.resolve(tree, name.split("/")),
          ({ route }) => invoke(route, input)
        )
      )
    }
  })

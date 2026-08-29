/**
 * The segment trie shared by every command projection.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { FsError } from "./FsError.ts"
import type * as Route from "./Route.ts"

/**
 * A node of the command trie.
 *
 * A node may carry a route, children, or both: `domains` and `domains/list`
 * are both routable in the same tree.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CommandTree {
  readonly route: Option.Option<Route.Route>
  readonly children: ReadonlyMap<string, CommandTree>
}

/**
 * A route selected from an argv prefix, with the tokens it did not consume.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Resolved {
  readonly route: Route.Route
  readonly rest: ReadonlyArray<string>
}

interface MutableTree {
  route: Option.Option<Route.Route>
  readonly children: Map<string, MutableTree>
}

const emptyNode = (): MutableTree => ({ route: Option.none(), children: new Map() })

const freeze = (node: MutableTree): CommandTree => ({
  route: node.route,
  children: new Map(Array.from(node.children, ([segment, child]) => [segment, freeze(child)]))
})

/**
 * Builds the command trie once for a route set.
 *
 * Two routes claiming the same segment path is a build failure rather than a
 * last-writer-wins overwrite: a silently shadowed command is invisible.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (routes: ReadonlyArray<Route.Route>): Effect.Effect<CommandTree, FsError> =>
  Effect.suspend(() => {
    const root = emptyNode()
    for (const route of routes) {
      let node = root
      for (const segment of route.segments) {
        let child = node.children.get(segment)
        if (child === undefined) {
          child = emptyNode()
          node.children.set(segment, child)
        }
        node = child
      }
      if (Option.isSome(node.route)) {
        return Effect.fail(
          new FsError({
            code: "duplicate_route",
            method: "CommandTree.make",
            description: `Two routes claim the command "${route.name}"`
          })
        )
      }
      node.route = Option.some(route)
    }
    return Effect.succeed(freeze(root))
  })

/**
 * Resolves the longest routable prefix of an argv.
 *
 * @category resolution
 * @since 0.1.0
 * @slop
 */
export const resolve = (tree: CommandTree, argv: ReadonlyArray<string>): Effect.Effect<Resolved, FsError> =>
  Effect.suspend(() => {
    let node = tree
    let matched: { readonly route: Route.Route; readonly consumed: number } | undefined
    for (let index = 0; index < argv.length; index++) {
      const child = node.children.get(argv[index]!)
      if (child === undefined) break
      node = child
      if (Option.isSome(child.route)) matched = { route: child.route.value, consumed: index + 1 }
    }
    if (matched === undefined) {
      return Effect.fail(
        new FsError({
          code: "unknown_command",
          method: "CommandTree.resolve",
          description: `No command matches "${argv.join(" ")}"`
        })
      )
    }
    return Effect.succeed({ route: matched.route, rest: argv.slice(matched.consumed) })
  })

/**
 * Lists every route in the tree in stable segment order.
 *
 * @category getters
 * @since 0.1.0
 * @slop
 */
export const traverse = (tree: CommandTree): ReadonlyArray<Route.Route> => {
  const routes: Array<Route.Route> = []
  const visit = (node: CommandTree): void => {
    if (Option.isSome(node.route)) routes.push(node.route.value)
    for (const segment of Array.from(node.children.keys()).sort()) {
      visit(node.children.get(segment)!)
    }
  }
  visit(tree)
  return routes
}

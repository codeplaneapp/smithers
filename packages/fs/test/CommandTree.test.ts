import { Cause, Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CommandTree from "../src/CommandTree.ts"
import * as Route from "../src/Route.ts"
import { makeRoute } from "./helpers.ts"

const failure = async (effect: Effect.Effect<unknown, unknown>): Promise<any> => {
  const exit = await Effect.runPromise(Effect.exit(effect))
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("expected failure")
  return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

describe("CommandTree", () => {
  it("supports prefix routes, exact resolution, and stable traversal", async () => {
    const tree = await Effect.runPromise(CommandTree.make([
      makeRoute("z"),
      makeRoute("domains/list"),
      makeRoute("domains")
    ]))

    expect(CommandTree.traverse(tree).map((route) => route.name)).toEqual(["domains", "domains/list", "z"])
    expect((await Effect.runPromise(CommandTree.resolve(tree, ["domains", "list", "arg"]))).rest).toEqual(["arg"])
    expect((await Effect.runPromise(CommandTree.resolveExact(tree, ["domains", "list"]))).name).toBe("domains/list")
    expect((await failure(CommandTree.resolveExact(tree, ["domains", "list", "typo"]))).code).toBe(
      "unknown_command"
    )
  })

  it("detaches route metadata and exposes immutable maps", async () => {
    const source = makeRoute("mutable") as Route.Route & { name: string; segments: Array<string> }
    const tree = await Effect.runPromise(CommandTree.make([source]))
    source.name = "changed"
    source.segments[0] = "changed"

    expect(CommandTree.traverse(tree)[0]).toMatchObject({ name: "mutable", segments: ["mutable"] })
    expect(Object.isFrozen(CommandTree.traverse(tree)[0])).toBe(true)
    expect(Object.isFrozen(tree)).toBe(true)
    expect((tree.children as unknown as { set?: unknown }).set).toBeUndefined()
  })

  it("rejects duplicate, mismatched, sparse, and hostile route inputs", async () => {
    expect((await failure(CommandTree.make([makeRoute("same"), makeRoute("same")]))).code).toBe("duplicate_route")
    expect(
      (await failure(CommandTree.make([
        makeRoute("name", undefined, { segments: ["different"] })
      ]))).code
    ).toBe("invalid_route")

    const sparse = new Array<Route.Route>(1)
    expect((await failure(CommandTree.make(sparse))).code).toBe("invalid_route")
    expect((await failure(CommandTree.make({} as never))).code).toBe("invalid_route")
    class Derived extends Array<Route.Route> {}
    expect((await failure(CommandTree.make(new Derived()))).code).toBe("invalid_route")
    const accessor = Object.defineProperty([], "0", { enumerable: true, get: () => makeRoute("bad") })
    Object.defineProperty(accessor, "length", { value: 1 })
    expect((await failure(CommandTree.make(accessor as Array<Route.Route>))).code).toBe("invalid_route")
    const hostile = new Proxy([makeRoute("bad")], {
      ownKeys: () => {
        throw new Error("trap")
      }
    })
    expect((await failure(CommandTree.make(hostile))).code).toBe("invalid_route")
  })

  it("enforces route, depth, segment, and resolution bounds", async () => {
    const routes = Array.from({ length: CommandTree.maximumRoutes }, (_, index) => makeRoute(`r${index}`))
    expect(CommandTree.traverse(await Effect.runPromise(CommandTree.make(routes)))).toHaveLength(
      CommandTree.maximumRoutes
    )
    expect((await failure(CommandTree.make([...routes, makeRoute("overflow")]))).code).toBe("resource_limit")

    const tooDeep = Array.from({ length: Route.maximumRouteDepth + 1 }, (_, index) => `d${index}`).join("/")
    expect((await failure(CommandTree.make([makeRoute(tooDeep)]))).code).toBe("invalid_route")

    const wide = Array.from({ length: 65 }, (_, route) => {
      const segments = Array.from({ length: Route.maximumRouteDepth }, (_, segment) => `r${route}-${segment}`)
      return makeRoute(segments.join("/"))
    })
    expect((await failure(CommandTree.make(wide))).code).toBe("resource_limit")

    const tree = await Effect.runPromise(CommandTree.make([makeRoute("one")]))
    const tokens = Array.from({ length: CommandTree.maximumResolutionTokens + 1 }, () => "x")
    expect((await failure(CommandTree.resolve(tree, tokens))).code).toBe("resource_limit")
  })

  it("does not echo unknown argv into errors", async () => {
    const tree = await Effect.runPromise(CommandTree.make([makeRoute("known")]))
    const error = await failure(CommandTree.resolve(tree, ["missing", "--api-key=TOP-SECRET"]))
    expect(error.code).toBe("unknown_command")
    expect(JSON.stringify(error)).not.toContain("TOP-SECRET")
  })
})

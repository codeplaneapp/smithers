import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Lsp from "../src/Lsp.ts"

const server = LanguageServer.make({
  hover: (position) => Effect.succeed(position),
  definition: (position) => Effect.succeed(position),
  references: (position) => Effect.succeed([position]),
  implementation: (position) => Effect.succeed(position),
  documentSymbols: (path) => Effect.succeed([path]),
  workspaceSymbols: (query) => Effect.succeed([query]),
  prepareCallHierarchy: (position) => Effect.succeed(position),
  callHierarchyIncoming: (position) => Effect.succeed(position),
  callHierarchyOutgoing: (position) => Effect.succeed(position),
  diagnostics: (path) => Effect.succeed([path])
})

describe("Lsp", () => {
  it("normalizes one-based positions before provider dispatch", async () => {
    const output = await Effect.runPromise(
      Lsp.run({ operation: "hover", path: "/workspace/a.ts", line: 2, character: 3 }).pipe(
        Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server))
      )
    )
    expect(output.result).toEqual({ path: "/workspace/a.ts", line: 1, character: 2 })
  })

  it("exposes the unsupported noop path", async () => {
    const exit = await Effect.runPromiseExit(
      Lsp.run({ operation: "diagnostics", path: "/workspace/a.ts" }).pipe(Effect.provide(LanguageServer.layerNoop))
    )
    expect(exit._tag).toBe("Failure")
  })

  it("dispatches prepareCallHierarchy with normalized positions", async () => {
    const output = await Effect.runPromise(
      Lsp.run({
        operation: "prepareCallHierarchy",
        path: "/workspace/a.ts",
        line: 4,
        character: 5
      }).pipe(Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server)))
    )
    expect(output.result).toEqual({ path: "/workspace/a.ts", line: 3, character: 4 })
  })

  it("rejects relative paths before provider dispatch", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Lsp.run({ operation: "diagnostics", path: "src/a.ts" }).pipe(
          Effect.provide(Layer.succeed(LanguageServer.LanguageServer, server))
        )
      )
    )
    expect(failure).toMatchObject({
      code: "invalid_input"
    })
  })
})

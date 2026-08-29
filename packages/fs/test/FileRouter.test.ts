import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Layer, Option } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as FileRouter from "../src/FileRouter.ts"

const root = fileURLToPath(new URL("./fixtures/router/flows", import.meta.url))

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const scan = () => Effect.runPromise(FileRouter.scan({ root }).pipe(Effect.provide(platformLayer)))

describe("FileRouter", () => {
  it("routes directory entries by path without evaluating module bodies", async () => {
    const result = await scan()

    expect(result.routes.map((route) => route.name)).toEqual([
      "directives/panel",
      "directives/sandboxed",
      "domains",
      "domains/list",
      "mixed",
      "review",
      "skills/demo"
    ])
    expect(result.routes.find((route) => route.name === "review")?.segments).toEqual(["review"])
    expect(result.routes.find((route) => route.name === "domains/list")?.segments).toEqual(["domains", "list"])
    expect(result.routes.find((route) => route.name === "review")?.sourcePath).toMatch(/review\/flow\.ts$/)
  })

  it("preserves registry entry precedence and diagnostics", async () => {
    const result = await scan()

    expect(result.routes.find((route) => route.name === "mixed")?.kind).toBe("module")
    expect(result.routes.find((route) => route.name === "mixed")?.sourcePath).toMatch(/mixed\/flow\.ts$/)
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "multiple_entry_files", path: expect.stringMatching(/mixed$/) }),
      expect.objectContaining({ code: "root_level_entry", path: expect.stringMatching(/flows\/flow\.ts$/) }),
      expect.objectContaining({ code: "name_field_ignored", path: expect.stringMatching(/review\/flow\.ts$/) })
    ]))
  })

  it("records UI companions without routing companions or colocated tests", async () => {
    const result = await scan()
    const review = result.routes.find((route) => route.name === "review")

    expect(Option.getOrUndefined(review?.ui ?? Option.none())).toMatch(/review\/ui\.tsx$/)
    expect(result.routes.some((route) => route.sourcePath.endsWith("/ui.tsx"))).toBe(false)
    expect(result.routes.some((route) => route.sourcePath.endsWith("/flow.test.ts"))).toBe(false)
  })

  it("routes skills as metadata while leaving skill parsing lazy", async () => {
    const result = await scan()
    const skill = result.routes.find((route) => route.name === "skills/demo")

    expect(skill).toMatchObject({ kind: "skill", sourcePath: expect.stringMatching(/SKILL\.md$/) })
  })

  it("is deterministic", async () => {
    const first = await scan()
    const second = await scan()

    expect(second).toEqual(first)
  })
})

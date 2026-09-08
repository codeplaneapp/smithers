import * as ModelPackage from "@smthrs/model"
import * as ModelErrorModule from "@smthrs/model/ModelError"
import * as EffectPackage from "effect"
import { Effect, Stream } from "effect"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const guide = readFileSync(new URL("../docs/guides/handle-failures.md", import.meta.url), "utf8")
const modules: Record<string, unknown> = {
  "@smthrs/model": ModelPackage,
  "@smthrs/model/ModelError": ModelErrorModule,
  effect: EffectPackage
}

const example = (heading: string): string => {
  const section = guide.split(`## ${heading}\n`)[1]
  const fence = section?.match(/```ts\n([\s\S]*?)```/)?.[1]
  expect(fence, `TypeScript example under ${heading}`).toBeDefined()
  return ts.transpileModule(fence!, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

describe("failure guide", () => {
  it.each(["quota_exceeded", "context_overflow", "call_timeout", "transport"] as const)(
    "preserves a scripted %s failure without turning the predicate into a defect",
    async (code) => {
      const error = new ModelErrorModule.ModelError({ code, message: "scripted provider failure" })
      const program = new Function("exports", "require", "request", `${example("Branch on the code")}\nreturn program`)(
        {},
        (id: string) => modules[id],
        { modelId: "test", messages: [] }
      ) as Effect.Effect<unknown, ModelErrorModule.ModelError, ModelPackage.Model.Model>

      const failure = await Effect.runPromise(
        program.pipe(
          Effect.provide(ModelPackage.Model.layer({ stream: () => Stream.fail(error) })),
          Effect.flip
        )
      )
      expect(failure).toBe(error)
    }
  )
})

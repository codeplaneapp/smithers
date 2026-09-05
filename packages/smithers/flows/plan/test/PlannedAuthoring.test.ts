import { describe, expect, it } from "@effect/vitest"
import { ESLint } from "eslint"
import tseslint from "typescript-eslint"
import * as Node from "../src/Node.ts"
import type * as Planned from "../src/Planned.ts"

describe("explicit planned-value authoring", () => {
  it("refuses callback sequencing at both the TypeScript and JavaScript boundary", () => {
    const choose = (value: Planned.Planned<boolean>) => value ? Node.succeed("yes") : Node.succeed("no")
    // @ts-expect-error Ordinary sequencing no longer accepts a symbolic callback.
    expect(() => Node.andThen(Node.succeed(false), choose)).toThrow("Node.bindPlanned")
    // @ts-expect-error The curried overload enforces the same contract.
    expect(() => Node.succeed(false).pipe(Node.andThen(choose))).toThrow("Node.bindPlanned")
    expect(Node.andThen(Node.succeed(false), Node.succeed("done")).ast._tag).toBe("AndThen")
    expect(Node.bindPlanned(Node.succeed(false), choose).ast._tag).toBe("AndThen")
  })

  it("the documented type-aware lint rule rejects planned truthiness but accepts real-value branches", async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [{
        files: ["**/*.ts"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            projectService: { allowDefaultProject: ["planned-lint.ts"] },
            tsconfigRootDir: process.cwd()
          }
        },
        plugins: { "@typescript-eslint": tseslint.plugin },
        rules: { "@typescript-eslint/strict-boolean-expressions": "error" }
      }]
    })
    const [result] = await eslint.lintText(
      `
import * as Node from "./src/Node.ts"
Node.bindPlanned(Node.succeed(false), (value) => value ? Node.succeed("yes") : Node.succeed("no"))
Node.bindPlanned(Node.succeed(false), (value) => {
  if (value) return Node.succeed("yes")
  return Node.succeed("no")
})
Node.bindPlanned(Node.succeed(false), (value) => Node.succeed(Boolean(value)))
Node.branch(Node.succeed(false), { if: (value) => value, then: () => Node.succeed("yes"), else: () => Node.succeed("no") })
Node.map(Node.succeed(false), (value) => value ? "yes" : "no")
`,
      { filePath: "planned-lint.ts" }
    )
    // This rule catches conditional truthiness. Explicit Boolean(...) coercion
    // and identity equality still require review; JavaScript has no proxy trap.
    expect(result!.fatalErrorCount).toBe(0)
    expect(result!.messages.map(({ ruleId, messageId, line }) => ({ ruleId, messageId, line }))).toEqual([
      { ruleId: "@typescript-eslint/strict-boolean-expressions", messageId: "conditionErrorObject", line: 3 },
      { ruleId: "@typescript-eslint/strict-boolean-expressions", messageId: "conditionErrorObject", line: 5 }
    ])
  })
})

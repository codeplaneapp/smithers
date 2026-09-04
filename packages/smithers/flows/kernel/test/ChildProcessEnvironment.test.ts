import { describe, expect, it } from "vitest"
import * as ChildProcessEnvironment from "../src/ChildProcessEnvironment.ts"

describe("ChildProcessEnvironment", () => {
  it("selects bootstrap and locale names without ambient credentials", () => {
    const environment = ChildProcessEnvironment.make({
      PATH: "/bin",
      HOME: "/home/runner",
      LC_MESSAGES: "C",
      ANTHROPIC_API_KEY: "ambient-anthropic",
      OPENAI_API_KEY: "ambient-openai",
      GH_TOKEN: "ambient-github",
      ORDINARY_AMBIENT: "hidden"
    }, {
      ORDINARY_DECLARED: "visible",
      EXPLICIT_API_KEY: "declared-secret"
    })

    expect(environment).toEqual({
      PATH: "/bin",
      HOME: "/home/runner",
      LC_MESSAGES: "C",
      ORDINARY_DECLARED: "visible",
      EXPLICIT_API_KEY: "declared-secret"
    })
    expect(Object.getPrototypeOf(environment)).toBeNull()
  })

  it("lets an undefined declaration remove an inherited name", () => {
    expect(ChildProcessEnvironment.make({ PATH: "/bin", LANG: "C" }, { LANG: undefined }))
      .toEqual({ PATH: "/bin" })
  })
})

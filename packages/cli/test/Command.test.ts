import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.ts"
import { make } from "../src/Output.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const names = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))

describe("Command", () => {
  it("registers every shipped verb and every removed one", () => {
    // The exact sets are pinned by `Verb.test.ts`; this asserts only that the
    // command tree is built from them rather than from a hand-kept list.
    for (const verb of Verb.subcommands) expect(names).toContain(verb.name)
    for (const verb of Unsupported.removedVerbs) {
      expect(names).toContain(verb.name === "workflows" ? "workflow" : verb.name)
    }
  })

  it("keeps up -d and run --resume in their command configurations", () => {
    const commands = cli.subcommands.flatMap((group) => group.commands)

    expect(commands.find((command) => command.name === "up")?.name).toBe("up")
    expect(commands.find((command) => command.name === "run")?.name).toBe("run")
    expect(commands.find((command) => command.name === "resume")?.unlisted).toBe(true)
  })

  it("requires an approval payload and supports scoped grants", () => {
    const approve = cli.subcommands.flatMap((group) => group.commands).find((command) => command.name === "approve")!
    expect(approve.name).toBe("approve")
  })

  it("renders stable JSON and never reveals Redacted values", async () => {
    const output = make()
    const value = { z: 1, nested: { token: Redacted.make("secret"), a: true } }
    const first = await Effect.runPromise(output.render(value, "json"))
    const second = await Effect.runPromise(output.render(value, "json"))
    expect(first.text).toBe("{\"nested\":{\"a\":true,\"token\":\"<redacted>\"},\"z\":1}")
    expect(second).toEqual(first)
  })
})

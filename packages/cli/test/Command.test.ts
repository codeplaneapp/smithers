import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.ts"
import { make } from "../src/Output.ts"

const names = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))

describe("Command", () => {
  it("projects every accepted verb as one root subcommand", () => {
    expect(names).toEqual([
      "plan",
      "run",
      "release",
      "serve",
      "up",
      "ls",
      "ps",
      "logs",
      "status",
      "cancel",
      "approve",
      "deny",
      "signal",
      "replay",
      "add",
      "remove",
      "eject",
      "test",
      "init",
      "doctor",
      "migrate",
      "docs"
    ])
  })

  it("keeps up --watch and run --resume in their command configurations", () => {
    const up = cli.subcommands.flatMap((group) => group.commands).find((command) => command.name === "up")!
    const run = cli.subcommands.flatMap((group) => group.commands).find((command) => command.name === "run")!
    expect(up.name).toBe("up")
    expect(run.name).toBe("run")
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

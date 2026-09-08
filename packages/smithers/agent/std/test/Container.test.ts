import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Path } from "effect"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Container from "../src/Container.ts"

const request = (container: string): Container.Request => ({
  container,
  file: "bash",
  args: ["-lc", "echo ready"],
  cwd: "/work",
  env: { MODE: "test" },
  stdin: true
})

describe("Container.makeCommand", () => {
  it("places the option terminator before a normal container name", async () => {
    const plan = await Effect.runPromise(Container.makeCommand().exec(request("worker-1")))

    expect(plan).toEqual({
      file: "docker",
      args: [
        "exec",
        "-i",
        "-w",
        "/work",
        "-e",
        "MODE",
        "--",
        "worker-1",
        "bash",
        "-lc",
        "echo ready"
      ],
      env: { MODE: "test" }
    })
  })

  it("forwards a requested variable by name, never by value", async () => {
    // `docker exec -e KEY` and `podman exec -e KEY` read the value from their
    // own environment, which is what `Plan.env` is for. A value written into
    // the argv would sit in the process table for every local reader and in
    // every rendering of that argv.
    const plan = await Effect.runPromise(
      Container.makeCommand().exec({
        ...request("worker-1"),
        env: { DATABASE_PASSWORD: "s3cret-value" }
      })
    )

    expect(plan.args).toContain("DATABASE_PASSWORD")
    expect(plan.args.join(" ")).not.toContain("s3cret-value")
    expect(plan.env).toEqual({ DATABASE_PASSWORD: "s3cret-value" })
  })

  it.each(["--privileged", ""])("refuses container name %j before spawning", async (container) => {
    let spawns = 0
    const spawner = ChildProcessSpawner.makeNoop({
      spawn: () => {
        spawns++
        return Effect.fail(new Error("unexpected spawn") as never)
      }
    })
    const exit = await Effect.runPromise(
      Effect.exit(Bash.run({ mode: "unhermetic", container, command: "echo ready" })).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner),
          Layer.succeed(Container.Container)(Container.makeCommand()),
          Path.layer
        ))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.getOrUndefined(failure)).toMatchObject({ code: "invalid_input", path: container })
    }
    expect(spawns).toBe(0)
  })
})

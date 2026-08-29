import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Path, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Container from "../src/Container.ts"
import { MAX_SHELL_OUTPUT_BYTES } from "../src/internal/Text.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** One spawned invocation, exactly as the host received it. */
interface Spawned {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string | undefined
  readonly shell: boolean
  readonly cwd: string | undefined
}

/**
 * Records what was spawned instead of running it. The scripted host in
 * `TestLayers` cannot supply standard input — `just-bash` has no pipe — so a
 * script-carrying call is observed here at the spawner boundary, which is
 * exactly where the payload stops being text and becomes data.
 */
const recorder = (spawns: Array<Spawned>) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        Effect.gen(function*() {
          const standard = command as ChildProcess.StandardCommand
          const stdin = standard.options.stdin
          const text = stdin !== undefined && typeof stdin !== "string" && Stream.isStream(stdin)
            ? yield* Stream.mkString(Stream.decodeText(stdin))
            : undefined
          spawns.push({
            file: standard.command,
            args: [...standard.args],
            stdin: text,
            shell: standard.options.shell === true,
            cwd: standard.options.cwd
          })
          return makeHandle({
            pid: ProcessId(1),
            exitCode: Effect.succeed(ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        })
    })),
    Path.layer
  )

describe("Bash", () => {
  it("returns non-zero exit codes as successful results", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        command: "failing-command"
      }),
      layer({
        commands: {
          "failing-command": { stdout: "partial output", stderr: "failed", exitCode: 23 }
        }
      })
    ))

    expect(result).toMatchObject({
      exitCode: 23,
      stdout: "partial output",
      stderr: "failed",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    })
  })

  it("caps stdout and stderr independently and retains each multibyte tail", async () => {
    const stdout = `${"🙂".repeat(7_501)}TAIL`
    const stderr = `${"é".repeat(15_002)}END`
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        command: "large-output"
      }),
      layer({
        commands: {
          "large-output": { stdout, stderr, exitCode: 0 }
        }
      })
    ))

    const encoder = new TextEncoder()
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdout.endsWith("TAIL")).toBe(true)
    expect(result.stderr.endsWith("END")).toBe(true)
    expect(encoder.encode(result.stdout)).toHaveLength(MAX_SHELL_OUTPUT_BYTES)
    expect(encoder.encode(result.stderr).byteLength).toBeLessThanOrEqual(MAX_SHELL_OUTPUT_BYTES)
    expect(result.stdoutDroppedBytes).toBe(8)
    expect(result.stderrDroppedBytes).toBe(8)
    expect(result.stdoutDroppedBytes).toBe(encoder.encode(stdout).byteLength - encoder.encode(result.stdout).byteLength)
    expect(result.stderrDroppedBytes).toBe(encoder.encode(stderr).byteLength - encoder.encode(result.stderr).byteLength)
  })

  it("maps shell timeouts to the typed timeout error", async () => {
    // A process that never exits, so the handler's own deadline is the only
    // thing that can end the run.
    const stalled = ChildProcessSpawner.makeNoop({ spawn: () => Effect.never })
    const exit = await execute(
      Effect.exit(Bash.run({
        mode: "unhermetic",
        command: "timeout-command",
        timeoutMs: 1
      })).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(stalled),
          Path.layer
        ))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("timeout")
    }
  })

  it("runs hermetic commands whose path references are declared", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "cat ./input.txt > ./output.txt",
        cwd: "/work",
        reads: ["/work", "/work/input.txt"],
        writes: ["/work/output.txt"]
      }),
      layer({
        // The spawner resolves `cwd` against the filesystem, so the working
        // directory has to exist for the command to start.
        files: { "/work/input.txt": "seed" },
        commands: {
          "cat ./input.txt > ./output.txt": { stdout: "done", exitCode: 0 }
        }
      })
    ))

    expect(result).toMatchObject({ exitCode: 0, stdout: "done" })
  })

  it("checks command references when cwd is the explicit default", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/default.txt",
        cwd: ".",
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/default.txt"
        })
      }
    }
  })

  it("checks command references when cwd is the absolute resolved base", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/absolute.txt",
        cwd: process.cwd(),
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/absolute.txt"
        })
      }
    }
  })

  it("refuses an undeclared cwd outside the resolved base", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "true",
        cwd: "/elsewhere",
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/elsewhere"
        })
      }
    }
  })

  it("keeps omitted cwd unchanged", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "true",
        reads: [],
        writes: []
      }),
      layer({ commands: { true: { stdout: "done", exitCode: 0 } } })
    ))

    expect(result).toMatchObject({ exitCode: 0, stdout: "done" })
  })

  it("fails before spawn when a hermetic command reads an undeclared path", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/secret.txt",
        reads: ["/work/**"],
        writes: []
      })),
      layer({
        commands: {
          "cat /outside/secret.txt": { stdout: "must not run", exitCode: 0 }
        }
      })
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/secret.txt"
        })
      }
    }
  })

  it("fails before spawn when a hermetic command writes an undeclared path", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "touch /outside/result.txt",
        reads: [],
        writes: []
      })),
      layer({
        commands: {
          "touch /outside/result.txt": { stdout: "must not run", exitCode: 0 }
        }
      })
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_writes",
          path: "/outside/result.txt"
        })
      }
    }
  })

  it("hands a script to its interpreter as data, never as a quoted line", async () => {
    const spawns: Array<Spawned> = []
    const script = "import sys\nprint('single ' + \"double\" + `back` + '''triple''')\n"
    await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        interpreter: "python3",
        script,
        args: ["--flag", "a b"],
        cwd: "/work"
      }),
      recorder(spawns)
    ))
    expect(spawns).toEqual([{
      file: "python3",
      args: ["-", "--flag", "a b"],
      stdin: script,
      shell: false,
      cwd: "/work"
    }])
  })

  it("defaults a script to the shell and passes stdin for a command", async () => {
    const spawns: Array<Spawned> = []
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", script: "echo hello" }),
      recorder(spawns)
    ))
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "cat", stdin: "payload" }),
      recorder(spawns)
    ))
    expect(spawns[0]).toMatchObject({ file: "bash", args: ["-s"], stdin: "echo hello", shell: false })
    expect(spawns[1]).toMatchObject({ file: "cat", args: [], stdin: "payload", shell: true })
  })

  it("keeps the login shell inside the container, where the profile it reads lives", async () => {
    // The wrapper exists because an image activates the project's interpreter
    // from its own profile. A hermetic run is refused a container outright, and
    // a local spawn already has the host's environment, so neither may acquire
    // a login shell as a side effect of the container path: `-l` there reads
    // the developer's own profile into a run that declared its envelope.
    const spawns: Array<Spawned> = []
    await execute(Effect.provide(
      Bash.run({ mode: "hermetic", script: "echo hello", reads: [], writes: [] }),
      recorder(spawns)
    ))
    await execute(Effect.provide(
      Bash.run({ mode: "hermetic", command: "echo hello", reads: [], writes: [] }),
      recorder(spawns)
    ))
    expect(spawns[0]).toMatchObject({ file: "bash", args: ["-s"], stdin: "echo hello" })
    expect(spawns[1]).toMatchObject({ file: "echo hello", shell: true })
    for (const spawn of spawns) {
      expect(spawn.args ?? []).not.toContain("-l")
      expect(spawn.args ?? []).not.toContain("-lc")
      expect(spawn.args ?? []).not.toContain(`exec "$@"`)
    }
  })

  it("builds the container argv through the injected transport, with no quoting of its own", async () => {
    const spawns: Array<Spawned> = []
    const transport = Layer.succeed(Container.Container)(Container.makeCommand())
    await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        container: "swebench-1",
        cwd: "/testbed",
        env: { PYTHONHASHSEED: "0" },
        interpreter: "python",
        script: "print('it ran')"
      }),
      Layer.merge(recorder(spawns), transport)
    ))
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", container: "swebench-1", cwd: "/testbed", command: "pytest -q tests/test_x.py" }),
      Layer.merge(recorder(spawns), transport)
    ))
    // Both shapes reach the container through a login shell. The image's own
    // profile is what activates the project's interpreter, and r91 measured
    // what skipping it costs: `interpreter: "python3"` resolved to a Python
    // without the repository's dependencies on 30 of 45 graded instances.
    // `exec "$@"` replaces the shell with the interpreter, so the script still
    // arrives on the inherited standard input and no argument is re-parsed.
    expect(spawns[0]).toEqual({
      file: "docker",
      args: [
        "exec",
        "-i",
        "-w",
        "/testbed",
        "-e",
        "PYTHONHASHSEED=0",
        "swebench-1",
        "bash",
        "-lc",
        `exec "$@"`,
        "bash",
        "python",
        "-"
      ],
      stdin: "print('it ran')",
      shell: false,
      // The container owns the working directory, so the host spawn does not.
      cwd: undefined
    })
    expect(spawns[1]).toMatchObject({
      file: "docker",
      args: ["exec", "-w", "/testbed", "swebench-1", "bash", "-lc", "pytest -q tests/test_x.py"],
      stdin: undefined
    })
  })

  it("asks a containerised shell script for no login flag of its own", async () => {
    // The wrapper is already a login shell, so the inner interpreter is asked
    // for nothing but "read the program from stdin". Two login shells would
    // read the profile twice for the same activation.
    const spawns: Array<Spawned> = []
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", container: "swebench-1", script: "echo hello" }),
      Layer.merge(recorder(spawns), Layer.succeed(Container.Container)(Container.makeCommand()))
    ))
    expect(spawns[0]).toMatchObject({
      file: "docker",
      args: ["exec", "-i", "swebench-1", "bash", "-lc", `exec "$@"`, "bash", "bash", "-s"],
      stdin: "echo hello"
    })
  })

  it("refuses a container when the host binds no transport", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({ mode: "unhermetic", container: "absent", command: "true" })),
      recorder(spawns)
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("provider_unavailable")
      expect(Option.isSome(failure) && failure.value.message).toContain("no container transport")
    }
    expect(spawns).toEqual([])
  })

  it("refuses the input shapes that cannot mean one thing", async () => {
    const spawns: Array<Spawned> = []
    const refuse = async (input: Parameters<typeof Bash.run>[0]) => {
      const exit = await execute(Effect.provide(Effect.exit(Bash.run(input)), recorder(spawns)))
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      return Option.getOrUndefined(failure)?.message ?? ""
    }
    expect(await refuse({ mode: "unhermetic", command: "true", script: "true" })).toContain("never both")
    expect(await refuse({ mode: "unhermetic" })).toContain("Give either command")
    expect(await refuse({ mode: "unhermetic", script: "true", stdin: "x" })).toContain("already arrives")
    expect(await refuse({ mode: "unhermetic", command: "true", args: ["x"] })).toContain("args belong to a script")
    expect(await refuse({ mode: "unhermetic", command: "true", interpreter: "python" })).toContain("runs a script")
    expect(await refuse({ mode: "hermetic", command: "true", container: "c", reads: [], writes: [] }))
      .toContain("mode:unhermetic")
    expect(await refuse({ mode: "hermetic", script: "x = 1", interpreter: "python", reads: [], writes: [] }))
      .toContain("not a shell")
    expect(spawns).toEqual([])
  })

  it("pre-checks a hermetic shell script's paths exactly as it pre-checks a command", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        script: "cat /outside/secret.txt\n",
        reads: ["/work/**"],
        writes: []
      })),
      recorder(spawns)
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_reads",
        path: "/outside/secret.txt"
      })
    }
    expect(spawns).toEqual([])
  })

  it("makes the hermetic and unhermetic tiers explicit", () => {
    expect(Bash.effects).toMatchObject({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })
    expect(Bash.effectsFor({
      mode: "hermetic",
      command: "true",
      reads: ["/work/input"],
      writes: ["/work/output"]
    })).toMatchObject({
      tier: "compensable",
      mode: "hermetic",
      reads: ["/work/input"],
      writes: ["/work/output"]
    })
    expect(Bash.effectsFor({
      mode: "unhermetic",
      command: "true"
    })).toMatchObject({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })
  })

  it("separates a probe that never ran from a check that failed", async () => {
    // The django wave-3 result, at the boundary the model reads: exit 1, and
    // nothing whatsoever about the code under test.
    const broken = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "python -m pytest tests/admin_views" }),
      layer({
        commands: {
          "python -m pytest tests/admin_views": {
            stderr:
              "AttributeError: type object 'AdminViewBasicTest' has no attribute 'test_catch_all_view_append_slash'",
            exitCode: 1
          }
        }
      })
    ))
    expect(broken.exitCode).toBe(1)
    expect(broken.invalidProbe).toMatchObject({ reason: "unknown-test" })
    expect(broken.invalidProbe?.evidence).toContain("test_catch_all_view_append_slash")

    // The same exit code, from a check that actually ran.
    const ran = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "python -m pytest tests/admin_views" }),
      layer({
        commands: {
          "python -m pytest tests/admin_views": { stdout: "1 failed, 412 passed", exitCode: 1 }
        }
      })
    ))
    expect(ran.exitCode).toBe(1)
    expect(ran.invalidProbe).toBeUndefined()
  })

  it("omits the invalid-probe key entirely from an ordinary result", async () => {
    const result = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "true" }),
      layer({ commands: { true: { stdout: "", exitCode: 0 } } })
    ))

    expect(Object.hasOwn(result, "invalidProbe")).toBe(false)
  })

  it("classifies against the truncated text the caller receives", async () => {
    // Truncation keeps the tail, which is where a runner prints its refusal, so
    // the evidence line is always quotable from the returned output.
    const stderr = `${"padding\n".repeat(6_000)}ERROR: file or directory not found: tests/absent.py`
    const result = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "pytest tests/absent.py" }),
      layer({ commands: { "pytest tests/absent.py": { stderr, exitCode: 4 } } })
    ))

    expect(result.stderrTruncated).toBe(true)
    expect(result.invalidProbe?.reason).toBe("unknown-path")
    expect(result.stderr).toContain(result.invalidProbe?.evidence ?? "unreachable")
  })
})

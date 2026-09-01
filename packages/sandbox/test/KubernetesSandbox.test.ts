import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Path, PlatformError, Sink, Stream } from "effect"
import * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

// -----------------------------------------------------------------------------
// The kubectl CLI as a fake: real shells behind kubectl's argv contract.
// -----------------------------------------------------------------------------

// The fake emulates only what kubectl and the API server contribute — the
// run/wait/get/exec/delete verbs, server-side Pod uniqueness, phases, exit
// codes, and stderr text — and every guest command runs through a real
// `/bin/sh` against a real directory, so pidfiles, signals, `base64`, and
// `pgrep` are all genuine. The fixed guest pid directory is remapped under
// the test root the way the AWS fake remaps it; the local shell starts in the
// image's default directory (the test root), so the provider's `cd` is what
// places a command; and the guest program runs under a supervising local
// shell so a signalled command reports `128+signal` the way the kubectl
// client does instead of failing the local exit observation.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-kubernetes-sandbox-")))
const workdir = join(root, "workspace")
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

const encoder = new TextEncoder()

// A long-running fixture whose duration is this process's own, kept below the
// conformance suite's 4200+ range and apart from the container test file's
// 3700+ range, so no concurrent vitest worker's fixture can match this file's
// survivor probes. The probe brackets the last digit so it cannot match its
// own command line.
const sleepDuration = String(3850 + (process.pid % 150))
const sleeps = `sleep ${sleepDuration}`
const survivor = `pgrep -f 'sleep ${sleepDuration.slice(0, -1)}[${sleepDuration.slice(-1)}]'`

interface Call {
  readonly file: string
  readonly args: ReadonlyArray<string>
}

interface Response {
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly failSpawn?: boolean | undefined
  readonly failObserve?: boolean | undefined
}

interface Pod {
  phase: string
  readonly env: Record<string, string>
}

const remap = (token: string): string => token.replaceAll("/tmp/.smthrs-sbx", `${root}/.pids`)

const cluster = (fault: (args: ReadonlyArray<string>) => Response | undefined = () => undefined) => {
  const calls: Array<Call> = []
  const pods = new Map<string, Pod>()
  const canned = (response: Response) =>
    makeHandle({
      pid: ProcessId(1),
      exitCode: response.failObserve === true
        ? Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "exitCode", description: "lost" })
        )
        : Effect.succeed(ExitCode(response.exitCode ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: response.stdout === undefined ? Stream.empty : Stream.make(encoder.encode(response.stdout)),
      stderr: response.stderr === undefined ? Stream.empty : Stream.make(encoder.encode(response.stderr)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    })
  const spawner = makeSpawner((command: ChildProcess.Command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no pipelines here" })
        )
      }
      calls.push({ file: command.command, args: command.args })
      const injected = fault(command.args)
      if (injected?.failSpawn === true) {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "kubectl missing" })
        )
      }
      if (injected !== undefined) return canned(injected)
      const args = [...command.args]
      while (["--context", "--namespace", "--kubeconfig"].includes(args[0] ?? "")) args.splice(0, 2)
      if (args[0] === "run") {
        const name = args[1]!
        if (pods.has(name)) {
          return canned({ exitCode: 1, stderr: `Error from server (AlreadyExists): pods "${name}" already exists\n` })
        }
        const env: Record<string, string> = {}
        for (let index = 0; index < args.length; index++) {
          if (args[index] !== "--env") continue
          const assignment = args[index + 1]!
          const separator = assignment.indexOf("=")
          env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
        }
        pods.set(name, { phase: "Running", env })
        return canned({ stdout: `pod/${name} created\n` })
      }
      if (args[0] === "wait") {
        const name = args.find((arg) => arg.startsWith("pod/"))?.slice(4) ?? ""
        const pod = pods.get(name)
        if (pod === undefined) {
          return canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found\n` })
        }
        // kubectl blocks for its whole timeout on a Pod that can never become
        // Ready again; the fake reports the same failure without the wait.
        return pod.phase === "Running"
          ? canned({ stdout: `pod/${name} condition met\n` })
          : canned({ exitCode: 1, stderr: `error: timed out waiting for the condition on pods/${name}\n` })
      }
      if (args[0] === "get") {
        const pod = pods.get(args[2]!)
        return pod === undefined
          ? canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${args[2]}" not found\n` })
          : canned({ stdout: pod.phase })
      }
      if (args[0] === "delete") {
        const name = args[1]!.slice(4)
        return pods.delete(name)
          ? canned({ stdout: `pod "${name}" force deleted\n` })
          : canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found\n` })
      }
      // exec [-i|--stdin] NAME -- PROGRAM ARGS...
      let index = 1
      let interactive = false
      while (args[index] === "-i" || args[index] === "--stdin") {
        interactive = true
        index += 1
      }
      const name = args[index]!
      const pod = pods.get(name)
      if (pod === undefined) {
        return canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found\n` })
      }
      if (pod.phase !== "Running") {
        return canned({
          exitCode: 1,
          stderr: `error: cannot exec into a container in a completed pod; current phase is ${pod.phase}\n`
        })
      }
      const separator = args.indexOf("--")
      const guest = args.slice(separator + 1)
      const child = yield* local.spawn(
        ChildProcess.make("/bin/sh", ["-c", `"$0" "$@"; exit "$?"`, guest[0]!, ...guest.slice(1).map(remap)], {
          cwd: root,
          env: pod.env,
          extendEnv: true,
          ...interactive && Stream.isStream(command.options.stdin)
            ? { stdin: command.options.stdin as Stream.Stream<Uint8Array> }
            : {}
        })
      )
      return makeHandle({
        pid: child.pid,
        exitCode: child.exitCode,
        isRunning: child.isRunning,
        kill: (killOptions) => child.kill(killOptions),
        stdin: Sink.drain,
        stdout: child.stdout,
        stderr: child.stderr,
        all: child.all,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: child.unref
      })
    })
  )
  return { calls, pods, spawner }
}

const acquired = <A, E>(
  provider: ReturnType<typeof KubernetesSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>,
  session = "run-1"
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire(session), body))

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(command, options)
      const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
      const code = yield* process.exitCode
      return { stdout, code }
    })
  )

describe("KubernetesSandbox", () => {
  it.effect("threads shaping and global flags through the full Pod lifecycle", () =>
    Effect.gen(function*() {
      const spaced = join(root, "work dir")
      const fake = cluster()
      const provider = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "img:tag",
        namespace: "test-ns",
        program: "k",
        context: "test-context",
        kubeconfig: "/tmp/kube config",
        workdir: spaced,
        env: { SEED: "1" },
        labels: { app: "sandbox", tier: "test" },
        resources: {
          requests: { cpu: "10m", memory: "16Mi" },
          limits: { cpu: "100m", memory: "64Mi" }
        },
        serviceAccount: "runner",
        nodeSelector: { "kubernetes.io/os": "linux" },
        createArgs: ["--image-pull-policy", "IfNotPresent"],
        namePrefix: "T_"
      })
      const session = yield* acquired(provider, (session) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* session.writeFile(`${spaced}/file.bin`, new Uint8Array([1, 2]))
            expect(Array.from(yield* session.readFile(`${spaced}/file.bin`))).toEqual([1, 2])
            // The container-wide environment reaches every spawned command.
            expect(
              yield* Effect.scoped(
                Effect.flatMap(
                  session.spawn(`printf '%s' "$SEED"`, {}),
                  (process) => Stream.mkString(Stream.decodeText(process.stdout))
                )
              )
            ).toBe("1")
            const remote = yield* session.spawn(sleeps, {})
            yield* session.kill!(remote, "SIGTERM")
            expect(yield* remote.exitCode).toBe(143)
            yield* session.ping!
            return session
          })
        ))
      expect(session).toMatchObject({ id: "run-1", workdir: spaced })
      expect(session.remoteId.startsWith("t-run-1-")).toBe(true)
      const globals = [
        "--context",
        "test-context",
        "--namespace",
        "test-ns",
        "--kubeconfig",
        "/tmp/kube config"
      ]
      for (const call of fake.calls) {
        expect(call.file).toBe("k")
        expect(call.args.slice(0, globals.length)).toEqual(globals)
      }
      const localCalls = fake.calls.map((call) => call.args.slice(globals.length))
      const created = localCalls.find((args) => args[0] === "run")!
      expect(created.slice(0, 12)).toEqual([
        "run",
        session.remoteId,
        "--image",
        "img:tag",
        "--restart",
        "Never",
        "--env",
        "SEED=1",
        "--labels",
        "app=sandbox,tier=test",
        "--override-type",
        "strategic"
      ])
      const overrides = JSON.parse(created[13]!)
      expect(overrides).toEqual({
        apiVersion: "v1",
        spec: {
          serviceAccountName: "runner",
          nodeSelector: { "kubernetes.io/os": "linux" },
          containers: [{
            name: session.remoteId,
            resources: {
              requests: { cpu: "10m", memory: "16Mi" },
              limits: { cpu: "100m", memory: "64Mi" }
            }
          }]
        }
      })
      expect(created.slice(14)).toEqual([
        "--image-pull-policy",
        "IfNotPresent",
        "--command",
        "--",
        "sleep",
        "infinity"
      ])
      expect(localCalls.find((args) => args[0] === "wait")).toEqual([
        "wait",
        "--for=condition=Ready",
        `pod/${session.remoteId}`,
        "--timeout=300s"
      ])
      expect(localCalls.find((args) => args.at(-1)?.startsWith("mkdir -p") === true)!.at(-1)).toBe(
        `mkdir -p '${spaced}' && rm -rf /tmp/.smthrs-sbx && mkdir -p /tmp/.smthrs-sbx`
      )
      expect(localCalls.find((args) => args[0] === "delete")).toEqual([
        "delete",
        `pod/${session.remoteId}`,
        "--force",
        "--grace-period=0"
      ])
    }), 30_000)

  it.effect("reattaches an existing Pod and preserves its files", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "alpine", workdir })
      const leaked = yield* Scope.make()
      const first = yield* Effect.provideService(provider.acquire("resume"), Scope.Scope, leaked)
      yield* first.writeFile(`${first.workdir}/kept.bin`, new Uint8Array([0, 255, 1]))
      const resumed = yield* Effect.scoped(
        Effect.gen(function*() {
          const second = yield* provider.acquire("resume")
          const bytes = yield* second.readFile(`${second.workdir}/kept.bin`)
          return { remoteId: second.remoteId, bytes }
        })
      )
      expect(resumed.remoteId).toBe(first.remoteId)
      expect(Array.from(resumed.bytes)).toEqual([0, 255, 1])
      expect(fake.calls.filter((call) => call.args[0] === "run")).toHaveLength(2)
      // A live leftover is adopted, so its phase was inspected, not assumed.
      expect(fake.calls.some((call) => call.args[0] === "get" && call.args.includes("jsonpath={.status.phase}")))
        .toBe(true)
      expect(yield* Scope.close(leaked, Exit.void)).toBeUndefined()
    }), 30_000)

  it.effect(
    "replaces a leftover Pod finished in a terminal phase instead of waiting on it",
    () =>
      Effect.gen(function*() {
        const fake = cluster()
        const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        const leaked = yield* Scope.make()
        const first = yield* Effect.provideService(provider.acquire("finished"), Scope.Scope, leaked)
        fake.pods.get(first.remoteId)!.phase = "Succeeded"
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            expect(session.remoteId).toBe(first.remoteId)
            // The replacement is a usable machine, not the corpse.
            expect(yield* output(session, "printf 'reborn'")).toEqual({ stdout: "reborn", code: 0 })
          }), "finished")
        const verbs = fake.calls.map((call) => call.args[0])
        expect(verbs.filter((verb) => verb === "run")).toHaveLength(3)
        // The finished Pod was deleted between the refused create and the
        // fresh one, and the release deleted the replacement at the end.
        expect(verbs.indexOf("delete")).toBeLessThan(verbs.lastIndexOf("run"))
        expect(fake.pods.size).toBe(0)
        expect(Exit.isSuccess(yield* Effect.exit(Scope.close(leaked, Exit.void)))).toBe(true)

        // A phase that cannot be read leaves the reattach path as it was, and
        // the Ready wait reports the unusable machine.
        const unreadable = cluster((args) => args[0] === "get" ? { exitCode: 1, stderr: "rbac denied" } : undefined)
        const blindProvider = KubernetesSandbox.make({ spawner: unreadable.spawner, image: "img", workdir })
        const leakedToo = yield* Scope.make()
        const seeded = yield* Effect.provideService(blindProvider.acquire("blind"), Scope.Scope, leakedToo)
        unreadable.pods.get(seeded.remoteId)!.phase = "Succeeded"
        const waitFailure = yield* Effect.flip(acquired(blindProvider, Effect.succeed, "blind"))
        expect((waitFailure as ProviderError).message).toContain("did not become Ready")
        expect(unreadable.pods.size).toBe(0)
        yield* Scope.close(leakedToo, Exit.void)

        // A recreation the server refuses is an acquire failure, with nothing
        // left behind: the corpse is gone and no new Pod exists.
        let runs = 0
        const refusing = cluster((args) =>
          args[0] === "run" && ++runs === 3 ? { exitCode: 1, stderr: "exceeded quota" } : undefined
        )
        const refusingProvider = KubernetesSandbox.make({ spawner: refusing.spawner, image: "img", workdir })
        const leakedThrice = yield* Scope.make()
        const corpse = yield* Effect.provideService(refusingProvider.acquire("quota"), Scope.Scope, leakedThrice)
        refusing.pods.get(corpse.remoteId)!.phase = "Failed"
        const recreateFailure = yield* Effect.flip(acquired(refusingProvider, Effect.succeed, "quota"))
        expect((recreateFailure as ProviderError).message).toContain("could not be recreated")
        expect(refusing.pods.size).toBe(0)
        expect(refusing.calls.filter((call) => call.args[0] === "delete")).toHaveLength(1)
        yield* Scope.close(leakedThrice, Exit.void)
      }),
    30_000
  )

  it.effect("deletes a newly created Pod when Ready or workspace setup fails", () =>
    Effect.gen(function*() {
      const notReady = cluster((args) => args[0] === "wait" ? { exitCode: 1, stderr: "timed out" } : undefined)
      const waitError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: notReady.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((waitError as ProviderError).message).toContain("did not become Ready")
      expect(notReady.calls.some((call) => call.args[0] === "delete")).toBe(true)
      expect(notReady.pods.size).toBe(0)

      const noWorkspace = cluster((args) =>
        args[0] === "exec" && args.at(-1)?.startsWith("mkdir -p") === true
          ? { exitCode: 1, stderr: "read-only filesystem" }
          : undefined
      )
      const setupError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: noWorkspace.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((setupError as ProviderError).message).toContain("could not be prepared")
      expect(noWorkspace.calls.some((call) => call.args[0] === "delete")).toBe(true)
      expect(noWorkspace.pods.size).toBe(0)
    }))

  it.effect("refuses create failures and restates transport failures", () =>
    Effect.gen(function*() {
      // No workdir given: the default applies, and the refused create keeps
      // the fake from ever preparing /workspace on this host.
      const denied = cluster((args) =>
        args[0] === "run" ? { exitCode: 1, stderr: "Error from server (Forbidden): denied" } : undefined
      )
      const deniedError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: denied.spawner, image: "private" }), Effect.succeed)
      )
      expect((deniedError as ProviderError).code).toBe("unavailable")
      expect((deniedError as ProviderError).message).toContain("Forbidden")
      expect(denied.calls.some((call) => call.args[0] === "delete")).toBe(false)

      const missing = cluster((args) => args[0] === "run" ? { failSpawn: true } : undefined)
      const spawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: missing.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((spawnError as ProviderError).code).toBe("spawn_error")

      const lossy = cluster((args) => args[0] === "run" ? { failObserve: true } : undefined)
      const observeError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: lossy.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((observeError as ProviderError).code).toBe("unknown")
    }))

  it.effect(
    "spawns with a rooted cwd, env(1) environment, and stdin through the exec channel",
    () =>
      Effect.gen(function*() {
        const fake = cluster()
        const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            // A bare spawn runs in the workdir; kubectl exec itself starts
            // elsewhere, so this proves the script's `cd`.
            expect((yield* output(session, "pwd")).stdout).toBe(`${workdir}\n`)
            yield* output(session, "mkdir -p sub/nested")
            expect((yield* output(session, "pwd", { cwd: "./sub/nested/" })).stdout).toBe(`${workdir}/sub/nested\n`)
            expect((yield* output(session, "pwd", { cwd: root })).stdout).toBe(`${root}\n`)
            // `env(1)` delivers keys `export` would refuse, dropping only the
            // explicitly undefined ones.
            const delivered = yield* output(session, `printf '%s:%s' "$KEPT" "$(printenv WITH-DASH)"`, {
              env: { "KEPT": "two words", "WITH-DASH": "delivered", "DROPPED": undefined }
            })
            expect(delivered).toEqual({ stdout: "two words:delivered", code: 0 })
            // Standard input arrives on the exec's own input channel, verified
            // through the file the command writes.
            const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])
            expect((yield* output(session, "cat > stdin-copy.bin", { stdin: bytes })).code).toBe(0)
            expect(Array.from(yield* session.readFile(`${workdir}/stdin-copy.bin`))).toEqual(Array.from(bytes))
          }))
        const spawns = fake.calls.filter((call) => call.args.at(-1)?.includes("exec ") === true)
        expect(spawns[0]!.args).toEqual([
          "exec",
          spawns[0]!.args[1]!,
          "--",
          "sh",
          "-c",
          `cd ${workdir} && echo $$ > /tmp/.smthrs-sbx/0.pid`
            + " && if [ -e /tmp/.smthrs-sbx/0.pid.cancel ]; then exit 143; fi"
            + " && exec /bin/sh -c pwd"
        ])
        const withEnv = spawns.find((call) => call.args.at(-1)?.includes("env ") === true)!
        expect(withEnv.args.at(-1)).toContain(`exec env 'KEPT=two words' WITH-DASH=delivered /bin/sh -c`)
        expect(withEnv.args.at(-1)).not.toContain("DROPPED")
        expect(withEnv.args.at(-1)).not.toContain("export")
        const fed = spawns.find((call) => call.args.at(-1)?.includes("cat > stdin-copy.bin") === true)!
        expect(fed.args.slice(0, 2)).toEqual(["exec", "--stdin"])
        // Only a command with input asks for the input channel.
        expect(spawns.filter((call) => call.args.includes("--stdin"))).toHaveLength(1)
      }),
    30_000
  )

  it.effect(
    "signals the guest when a spawn scope closes on a live command, and not on an ended one",
    () =>
      Effect.gen(function*() {
        const fake = cluster()
        const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            const kills = () => fake.calls.filter((call) => call.args.at(-1)?.includes("kids()") === true).length
            yield* Effect.scoped(Effect.asVoid(session.spawn(sleeps, {})))
            expect(kills()).toBe(1)
            expect((yield* output(session, survivor)).code).not.toBe(0)
            yield* output(session, "true")
            expect(kills()).toBe(1)
          }))
      }),
    30_000
  )

  it.effect("kills a spawned command by pid walk inside the pod", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const signalled = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn(sleeps, {})
              yield* session.kill!(process, "SIGTERM")
              return yield* process.exitCode
            })
          )
          expect(signalled).toBe(143)
          expect((yield* output(session, survivor)).code).not.toBe(0)
        }))
      const kill = fake.calls.find((call) => call.args.at(-1)?.includes("kids()") === true)
      expect(kill!.args.at(-1)).toContain("while [ ! -s /tmp/.smthrs-sbx/0.pid ]")
      // One batch delivery to the collected set: killing children one at a
      // time before the parent lets a respawning parent replace them.
      expect(kill!.args.at(-1)).toContain(`kill -s TERM "$@"`)

      const refused = cluster((args) =>
        args.at(-1)?.includes("kids()") === true ? { exitCode: 1, stderr: "exec refused" } : undefined
      )
      const killError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: refused.spawner, image: "img", workdir }), (session) =>
          Effect.scoped(
            Effect.flatMap(session.spawn("sleep 30", {}), (process) => session.kill!(process, "SIGKILL"))
          ))
      )
      expect((killError as ProviderError).code).toBe("unknown")
      expect((killError as ProviderError).message).toContain("SIGKILL")
    }), 30_000)

  it.effect("round-trips bytes through base64 and classifies read and write failures", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const binary = new Uint8Array([0, 255, 254, 10, 13, 7])
          yield* session.writeFile(`${workdir}/deep/out.bin`, binary)
          expect(Array.from(yield* session.readFile(`${workdir}/deep/out.bin`))).toEqual(Array.from(binary))
          yield* session.writeFile(`${workdir}/void.bin`, new Uint8Array())
          expect(yield* session.readFile(`${workdir}/void.bin`)).toEqual(new Uint8Array())
          // A path with no parent to create takes the bare write.
          yield* session.writeFile("bare.bin", new Uint8Array([9]))
          expect(Array.from(yield* session.readFile(`${root}/bare.bin`))).toEqual([9])
          const absent = yield* Effect.flip(session.readFile(`${workdir}/absent`))
          expect((absent as ProviderError).code).toBe("not_found")
          writeFileSync(`${workdir}/sealed.bin`, "sealed")
          chmodSync(`${workdir}/sealed.bin`, 0)
          const refused = yield* Effect.flip(session.readFile(`${workdir}/sealed.bin`))
          expect((refused as ProviderError).code).toBe("unknown")
          expect((refused as ProviderError).message).toContain("Permission denied")
          writeFileSync(`${workdir}/blocker`, "a file, not a directory")
          const unwritable = yield* Effect.flip(session.writeFile(`${workdir}/blocker/child`, new Uint8Array([1])))
          expect((unwritable as ProviderError).code).toBe("unknown")
        }))
      const writes = fake.calls.filter((call) => call.args.includes("-i"))
      expect(writes[0]!.args.slice(0, 2)).toEqual(["exec", "-i"])
      expect(writes[0]!.args.at(-1)).toBe(`mkdir -p ${workdir}/deep && base64 -d > ${workdir}/deep/out.bin`)
      // Redirected, not positional: BSD `base64` takes no file operand.
      const reads = fake.calls.filter((call) => call.args.at(-1)?.includes("base64 < ") === true)
      expect(reads.length).toBeGreaterThan(0)

      const badRead = cluster((args) =>
        args.at(-1)?.includes(`base64 < ${workdir}/bad`) === true ? { stdout: "%%%" } : undefined
      )
      const badBase64 = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: badRead.spawner, image: "img", workdir }), (session) =>
          session.readFile(`${workdir}/bad`))
      )
      expect((badBase64 as ProviderError).message).toContain("invalid base64")

      const refusedWrite = cluster((args) =>
        args.includes("-i") ? { exitCode: 1, stderr: "read-only filesystem" } : undefined
      )
      const writeError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: refusedWrite.spawner, image: "img", workdir }), (session) =>
          session.writeFile(`${workdir}/out`, new Uint8Array([1])))
      )
      expect((writeError as ProviderError).code).toBe("unknown")

      const missingExec = cluster((args) =>
        args.includes("-i") ? { failSpawn: true } : undefined
      )
      const writeSpawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: missingExec.spawner, image: "img", workdir }), (session) =>
          session.writeFile(`${workdir}/out`, new Uint8Array([1])))
      )
      expect((writeSpawnError as ProviderError).code).toBe("spawn_error")
    }), 30_000)

  it.effect("answers ping and spawn failures honestly", () =>
    Effect.gen(function*() {
      const dead = cluster((args) => args.at(-1) === "true" ? { exitCode: 1, stderr: "pod gone" } : undefined)
      const pingError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: dead.spawner, image: "img", workdir }), (session) => session.ping!)
      )
      expect((pingError as ProviderError).code).toBe("unavailable")

      const noExec = cluster((args) => args.at(-1)?.includes("exec /bin/sh -c") === true ? { failSpawn: true } : undefined)
      const spawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: noExec.spawner, image: "img", workdir }), (session) =>
          Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
      )
      expect((spawnError as ProviderError).code).toBe("spawn_error")
    }))

  it.effect("handles empty resources and bounds sanitized Pod names", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "img",
        workdir,
        resources: {},
        namePrefix: "INVALID_PREFIX_THAT_IS_MUCH_TOO_LONG_TO_FIT_WITH_THE_COMPLETE_SESSION_SLUG_"
      })
      const session = yield* Effect.scoped(provider.acquire("UPPER_case.with/a/very/long/session/key"))
      expect(session.remoteId).toMatch(/^[a-z0-9-]+$/)
      expect(session.remoteId).toHaveLength(63)
      const create = fake.calls[0]!.args
      const overrides = JSON.parse(create[create.indexOf("--overrides") + 1]!)
      expect(overrides.spec.containers[0].resources).toEqual({})
    }))

  it.effect("passes SandboxConformance against the faithful kubectl fake", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "alpine:3.20", workdir })
      const violations = yield* SandboxConformance.check(provider, {
        provides: { kill: true, ping: true }
      })
      expect(violations).toEqual([])
    }), 120_000)
})

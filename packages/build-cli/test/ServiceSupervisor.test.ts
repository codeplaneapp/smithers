/**
 * ServiceSupervisor lifecycle proofs over a real node HTTP fixture server.
 *
 * Everything here spawns real processes and probes real sockets:
 *
 * 1. Readiness gates a consumer — the consumer's request succeeds even though
 *    the server delays `listen`, because acquire waits for the probe.
 * 2. A service that dies or stops answering mid-consumer fails the consumer
 *    through the health contract, with the tail of captured server output.
 * 3. The stop contract escalates: declared signal, grace, then SIGKILL of the
 *    process group — proven with a server that ignores SIGTERM.
 * 4. Refcounting shares one spawn across two parallel consumers and releases
 *    only after the last consumer's scope closes.
 * 5. SIGINT on the embedding process tears the service down (pgrep proves no
 *    orphan survives).
 */
import * as Effect from "effect/Effect"
import { execFile, spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"

const fixtureDir = NodePath.resolve(import.meta.dirname, "fixtures/service-supervisor")
const serverPath = NodePath.join(fixtureDir, "server.mjs")
const driverPath = NodePath.join(fixtureDir, "sigint-driver.ts")
const packageDir = NodePath.resolve(import.meta.dirname, "..")

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no port assigned")))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`)
}

const getText = (url: string): Promise<string> => fetch(url).then((response) => response.text())

const pgrep = (pattern: string): Promise<string> =>
  new Promise((resolve) => {
    execFile("pgrep", ["-f", pattern], (_error, stdout) => resolve(stdout.trim()))
  })

/** A fixture-server spec; extra argv flags append after the port. */
const serverSpec = (
  key: string,
  port: number,
  flags: ReadonlyArray<string>,
  probes: Pick<ServiceSupervisor.ServiceSpec, "readiness" | "health" | "stop">
): ServiceSupervisor.ServiceSpec => ({
  key,
  cwd: fixtureDir,
  argv: [process.execPath, serverPath, "--port", String(port), ...flags],
  ...probes
})

const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>).catch((error) => {
    throw error
  })

describe("parseDurationMs", () => {
  it("parses ms, s, m, and h", () => {
    expect(ServiceSupervisor.parseDurationMs("500ms", "t")).toBe(500)
    expect(ServiceSupervisor.parseDurationMs("15s", "t")).toBe(15_000)
    expect(ServiceSupervisor.parseDurationMs("90s", "t")).toBe(90_000)
    expect(ServiceSupervisor.parseDurationMs("2m", "t")).toBe(120_000)
    expect(ServiceSupervisor.parseDurationMs("1h", "t")).toBe(3_600_000)
    expect(ServiceSupervisor.parseDurationMs("1.5s", "t")).toBe(1_500)
  })

  it("refuses everything else loudly", () => {
    for (const bad of ["", "15", "15sec", "s15", "-1s", "0ms", "1 5s", "1d"]) {
      expect(() => ServiceSupervisor.parseDurationMs(bad, "t")).toThrowError(/duration/)
    }
  })
})

describe("spec validation", () => {
  const acquireFlipped = (
    spec: ServiceSupervisor.ServiceSpec
  ): Promise<ServiceSupervisor.ServiceError> =>
    run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      return yield* Effect.flip(supervisor.acquire(spec))
    }))) as Promise<ServiceSupervisor.ServiceError>

  it("refuses a bad readiness timeout format", async () => {
    const error = await acquireFlipped({
      key: "//x:bad-timeout",
      cwd: fixtureDir,
      argv: [process.execPath, serverPath],
      readiness: { http: "http://127.0.0.1:1/health", timeout: "15sec" }
    })
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toContain("readiness.timeout")
  })

  it("refuses health without readiness", async () => {
    const error = await acquireFlipped({
      key: "//x:health-no-readiness",
      cwd: fixtureDir,
      argv: [process.execPath, serverPath],
      health: { interval: "15s" }
    })
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toContain("health")
  })

  it("refuses a relative cwd, an empty argv, a bad signal, a bad port, and a bad URL", async () => {
    const base = {
      cwd: fixtureDir,
      argv: [process.execPath, serverPath] as const
    }
    const cases: Array<ServiceSupervisor.ServiceSpec> = [
      { key: "//x:rel", ...base, cwd: "relative/dir" },
      { key: "//x:argv", ...base, argv: [""] },
      { key: "//x:sig", ...base, stop: { signal: "TERM", grace: "5s" } },
      { key: "//x:port", ...base, readiness: { port: 0 } },
      { key: "//x:url", ...base, readiness: { http: "not a url", timeout: "5s" } }
    ]
    for (const spec of cases) {
      const error = await acquireFlipped(spec)
      expect(error.reason).toBe("invalid-spec")
    }
  })

  it("refuses two acquires of one key with different specs", async () => {
    const port = await freePort()
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      yield* supervisor.acquire(serverSpec("//x:drift", port, [], { readiness: { port } }))
      return yield* Effect.flip(
        supervisor.acquire(serverSpec("//x:drift", port, ["--extra-flag"], { readiness: { port } }))
      )
    }))) as ServiceSupervisor.ServiceError
    expect(error.reason).toBe("spec-drift")
  })
})

describe("readiness", () => {
  it("supports exec readiness and runs init only after readiness", async () => {
    const port = await freePort()
    const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-service-init-"))
    const marker = NodePath.join(directory, "ready")
    try {
      await run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          ...serverSpec("//x:exec-ready", port, ["--delay-listen", "300"], {}),
          readiness: {
            exec: [
              process.execPath,
              "-e",
              `fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`
            ],
            timeout: "10s"
          },
          init: [[process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ok')`]]
        })
        expect(alive(handle.pid)).toBe(true)
        const contents = yield* Effect.promise(() => Fs.readFile(marker, "utf8"))
        expect(contents).toBe("ok")
      })))
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("http readiness gates a consumer behind a delayed listen", async () => {
    const port = await freePort()
    const started = Date.now()
    const body = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:http-ready", port, ["--delay-listen", "500"], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" }
      }))
      expect(alive(handle.pid)).toBe(true)
      return yield* handle.whileHealthy(
        Effect.promise(() => getText(`http://127.0.0.1:${port}/instance`))
      )
    })))
    expect(body).toMatch(/^instance-/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  })

  it("port readiness gates a consumer behind a delayed listen", async () => {
    const port = await freePort()
    const body = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(
        serverSpec("//x:port-ready", port, ["--delay-listen", "300"], { readiness: { port } })
      )
      return yield* handle.whileHealthy(
        Effect.promise(() => getText(`http://127.0.0.1:${port}/instance`))
      )
    })))
    expect(body).toMatch(/^instance-/)
  })

  it("fails acquisition when readiness never comes, and still stops the child", async () => {
    const port = await freePort()
    const marker = `service-supervisor-timeout-proof-${process.pid}`
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      return yield* Effect.flip(supervisor.acquire(
        serverSpec("//x:never-ready", port, ["--delay-listen", "60000", "--marker", marker], {
          readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "1s" }
        })
      ))
    }))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(error.reason).toBe("readiness-timeout")
    expect(error.message).toContain("was not ready within 1000ms")
    await waitFor(async () => (await pgrep(marker)) === "", 10_000)
  })
})

describe("health", () => {
  it("fails the consumer when the server dies mid-consumer", async () => {
    const port = await freePort()
    let pid = -1
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:killed", port, [], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" },
        health: { interval: "150ms", failures: 2 }
      }))
      pid = handle.pid
      return yield* Effect.flip(handle.whileHealthy(Effect.gen(function*() {
        yield* Effect.sync(() => process.kill(handle.pid, "SIGKILL"))
        yield* Effect.sleep(20_000)
      })))
    }))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(error.reason).toBe("exited")
    expect(error.outputTail).toContain("listening")
    await waitFor(() => !alive(pid), 5_000)
  })

  it("fails the consumer via consecutive probe failures when the server stops answering", async () => {
    const port = await freePort()
    const started = Date.now()
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:wedged", port, [], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" },
        health: { interval: "150ms", failures: 2 }
      }))
      return yield* Effect.flip(handle.whileHealthy(Effect.gen(function*() {
        yield* Effect.promise(() => getText(`http://127.0.0.1:${port}/wedge`))
        yield* Effect.sleep(30_000)
      })))
    }))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(error.reason).toBe("unhealthy")
    expect(error.message).toContain("2 consecutive health probes")
    expect(error.message).toContain("answered 500")
    expect(error.outputTail).toContain("wedged")
    // Failed through the health contract, not by exhausting the consumer.
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  it("tolerates probe flaps below the failures threshold", async () => {
    const port = await freePort()
    const result = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:flappy", port, [], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" },
        health: { interval: "100ms", failures: 3 }
      }))
      return yield* handle.whileHealthy(Effect.gen(function*() {
        yield* Effect.promise(() => getText(`http://127.0.0.1:${port}/flap?n=1`))
        yield* Effect.sleep(700)
        return "survived"
      }))
    })))
    expect(result).toBe("survived")
  })
})

describe("stop contract", () => {
  it("escalates to SIGKILL of the group when the server ignores the stop signal", async () => {
    const port = await freePort()
    let pid = -1
    let releaseStarted = 0
    await run(Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire(serverSpec("//x:stubborn", port, ["--ignore-sigterm"], {
          readiness: { port },
          stop: { signal: "SIGTERM", grace: "400ms" }
        }))
        pid = handle.pid
        releaseStarted = Date.now()
      }))
    }))
    const releaseElapsed = Date.now() - releaseStarted
    expect(releaseElapsed).toBeGreaterThanOrEqual(400)
    await waitFor(() => !alive(pid), 5_000)
  })

  it("stops a cooperative server within the grace period", async () => {
    const port = await freePort()
    let pid = -1
    let releaseStarted = 0
    await run(Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire(serverSpec("//x:cooperative", port, [], {
          readiness: { port },
          stop: { signal: "SIGTERM", grace: "20s" }
        }))
        pid = handle.pid
        releaseStarted = Date.now()
      }))
    }))
    // Release settled on the child's exit, not by waiting out the full grace.
    expect(Date.now() - releaseStarted).toBeLessThan(10_000)
    await waitFor(() => !alive(pid), 5_000)
  })

  it("stops the service when the consumer fails", async () => {
    const port = await freePort()
    let pid = -1
    const error = await run(Effect.flip(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:consumer-fails", port, [], {
        readiness: { port }
      }))
      pid = handle.pid
      return yield* handle.whileHealthy(Effect.fail(new Error("consumer exploded")))
    }))))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("consumer exploded")
    await waitFor(() => !alive(pid), 5_000)
  })
})

describe("refcounting", () => {
  it("shares one spawn across two parallel consumers and releases after the last", async () => {
    const port = await freePort()
    const spec = serverSpec("//x:shared", port, [], {
      readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" }
    })
    const observed: Array<{ readonly pid: number; readonly instance: string }> = []
    let sharedPid = -1
    await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const consumer = (holdMs: number, checkAliveAt?: number) =>
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* supervisor.acquire(spec)
          sharedPid = handle.pid
          const instance = yield* Effect.promise(() => getText(`http://127.0.0.1:${port}/instance`))
          observed.push({ pid: handle.pid, instance })
          if (checkAliveAt !== undefined) {
            yield* Effect.sleep(checkAliveAt)
            // The short-lived sibling has released by now; the shared spawn
            // must still be alive because this consumer still holds it.
            expect(alive(handle.pid)).toBe(true)
            yield* Effect.sleep(Math.max(holdMs - checkAliveAt, 0))
            return
          }
          yield* Effect.sleep(holdMs)
        }))
      yield* Effect.all([consumer(200), consumer(1_500, 1_000)], { concurrency: 2 })
    })))
    expect(observed).toHaveLength(2)
    expect(observed[0]!.pid).toBe(observed[1]!.pid)
    expect(observed[0]!.instance).toBe(observed[1]!.instance)
    await waitFor(() => !alive(sharedPid), 5_000)
  })
})

describe("spawn failure", () => {
  it("refuses loudly when the executable does not exist", async () => {
    const error = await run(Effect.flip(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire({
        key: "//x:missing-binary",
        cwd: fixtureDir,
        argv: ["/nonexistent-service-supervisor-binary"]
      })
      return yield* handle.whileHealthy(Effect.sleep(10_000))
    })))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(["spawn-failed", "exited"]).toContain(error.reason)
  })
})

describe("SIGINT teardown", () => {
  it("kills the service process group when the embedding process gets SIGINT (pgrep proves no orphan)", async () => {
    const port = await freePort()
    const marker = "service-supervisor-sigint-proof"
    const driver = spawn(process.execPath, ["--import", "tsx", driverPath, String(port), serverPath], {
      cwd: packageDir,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    driver.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    let errors = ""
    driver.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8")
    })
    const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve) => {
        driver.on("close", (code, signal) => resolve({ code, signal }))
      }
    )
    try {
      await waitFor(() => /READY \d+/.test(output), 30_000).catch(() => {
        throw new Error(`driver never became ready.\nstdout: ${output}\nstderr: ${errors}`)
      })
      const serverPid = Number(/READY (\d+)/.exec(output)![1])
      expect(alive(serverPid)).toBe(true)
      expect(await pgrep(marker)).not.toBe("")
      driver.kill("SIGINT")
      const outcome = await exited
      // The backstop re-raises, so the driver dies of SIGINT itself.
      expect(outcome.signal).toBe("SIGINT")
      await waitFor(() => !alive(serverPid), 10_000)
      await waitFor(async () => (await pgrep(marker)) === "", 10_000)
    } finally {
      driver.kill("SIGKILL")
    }
  })
})

/**
 * The suite is a judge, so these tests are trials: providers built to break
 * one obligation each, and the assertion that the suite names exactly that
 * break. A suite only ever shown conforming providers would be a statement
 * about nothing.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

/** A session double satisfying every obligation the suite states. */
const conforming = (workdir = "/sandbox") =>
  Sandbox.TestSession.make({
    workdir,
    ping: Effect.void,
    scripts: {
      "pwd": { stdout: `${workdir}\n` },
      [`printf '%s' "$SANDBOX_CONFORMANCE"`]: { stdout: "delivered" },
      "printf 'again'": { stdout: "again" },
      "printf 'sandbox conformance'": { stdout: "sandbox conformance" },
      "exit 23": { exitCode: 23 }
    }
  })

const checkNames = (violations: ReadonlyArray<{ readonly check: string }>): ReadonlyArray<string> =>
  violations.map((violation) => violation.check)

describe("SandboxConformance", () => {
  it.effect("reports nothing for a conforming provider", () =>
    Effect.gen(function*() {
      const violations = yield* SandboxConformance.check(conforming(), {
        session: "judged",
        provides: { ping: true }
      })
      expect(violations).toEqual([])
    }))

  it.effect("uses its defaults when told nothing beyond the provider", () =>
    Effect.gen(function*() {
      const provider = conforming()
      const violations = yield* SandboxConformance.check(provider)
      // No declared capabilities means no ping or kill checks, and the file
      // checks all pass; the default session key is the one acquired.
      expect(violations).toEqual([])
      expect(provider.state.acquired[0]).toBe("sandbox-conformance")
    }))

  it.effect("names a session that corrupts the bytes it stored", () =>
    Effect.gen(function*() {
      const truthful = conforming()
      const corrupting: Sandbox.Provider = {
        acquire: (key) =>
          Effect.map(truthful.acquire(key), (session) => ({
            ...session,
            readFile: (path) => Effect.map(session.readFile(path), (bytes) => bytes.slice(0, bytes.length - 1))
          }))
      }
      const violations = yield* SandboxConformance.check(corrupting, { provides: { ping: true } })
      expect(checkNames(violations)).toContain("round-trips-binary-bytes")
    }))

  it.effect("names a session that reports absence with the wrong code, and one that fabricates content", () =>
    Effect.gen(function*() {
      const truthful = conforming()
      const wrongCode: Sandbox.Provider = {
        acquire: (key) =>
          Effect.map(truthful.acquire(key), (session) => ({
            ...session,
            readFile: (path) =>
              path.endsWith("conformance-absent")
                ? Effect.fail(new ProviderError({ code: "unknown", message: "something went wrong" }))
                : session.readFile(path)
          }))
      }
      expect(checkNames(yield* SandboxConformance.check(wrongCode))).toContain("reports-an-absent-file")

      const fabricating: Sandbox.Provider = {
        acquire: (key) =>
          Effect.map(truthful.acquire(key), (session) => ({
            ...session,
            readFile: (path) =>
              path.endsWith("conformance-absent")
                ? Effect.succeed(new Uint8Array([1]))
                : session.readFile(path)
          }))
      }
      expect(checkNames(yield* SandboxConformance.check(fabricating))).toContain("reports-an-absent-file")
    }))

  it.effect("names a session that refuses to create parent directories", () =>
    Effect.gen(function*() {
      const truthful = conforming()
      const flat: Sandbox.Provider = {
        acquire: (key) =>
          Effect.map(truthful.acquire(key), (session) => ({
            ...session,
            writeFile: (path, content) =>
              path.includes("/conformance/")
                ? Effect.fail(new ProviderError({ code: "unknown", message: "no such directory" }))
                : session.writeFile(path, content)
          }))
      }
      const violations = yield* SandboxConformance.check(flat)
      expect(checkNames(violations)).toContain("creates-parent-directories")
    }))

  it.effect("names a session that runs commands somewhere other than its workdir", () =>
    Effect.gen(function*() {
      const elsewhere = Sandbox.TestSession.make({
        workdir: "/sandbox",
        scripts: { "pwd": { stdout: "/elsewhere\n" } },
        script: () => ({ stdout: "" })
      })
      const violations = yield* SandboxConformance.check(elsewhere)
      expect(checkNames(violations)).toContain("runs-in-its-workdir")
    }))

  it.effect("names a session that drops the caller's environment", () =>
    Effect.gen(function*() {
      const deaf = Sandbox.TestSession.make({
        workdir: "/sandbox",
        scripts: {
          "pwd": { stdout: "/sandbox\n" },
          [`printf '%s' "$SANDBOX_CONFORMANCE"`]: { stdout: "" }
        },
        script: () => ({ stdout: "" })
      })
      const violations = yield* SandboxConformance.check(deaf)
      expect(checkNames(violations)).toContain("delivers-the-environment")
    }))

  it.effect("names a provider that cannot serve a session twice", () =>
    Effect.gen(function*() {
      const truthful = conforming()
      let acquisitions = 0
      const singleUse: Sandbox.Provider = {
        acquire: (key) =>
          Effect.suspend(() => {
            acquisitions += 1
            return acquisitions > 6
              ? Effect.fail(new ProviderError({ code: "unavailable", message: "machine budget spent" }))
              : truthful.acquire(key)
          })
      }
      const violations = yield* SandboxConformance.check(singleUse)
      expect(checkNames(violations)).toContain("reacquires-its-session")
    }))

  it.effect("carries the delegated spawn violations up whole", () =>
    Effect.gen(function*() {
      const silent = Sandbox.TestSession.make({
        workdir: "/sandbox",
        scripts: {
          "pwd": { stdout: "/sandbox\n" },
          [`printf '%s' "$SANDBOX_CONFORMANCE"`]: { stdout: "delivered" },
          "printf 'again'": { stdout: "again" },
          "printf 'sandbox conformance'": { stdout: "wrong words" },
          "exit 23": { exitCode: 0 }
        }
      })
      const violations = yield* SandboxConformance.check(silent)
      expect(checkNames(violations)).toEqual(
        expect.arrayContaining(["writes-its-output", "reports-a-nonzero-exit"])
      )
    }))
})

import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  artifactLifecycleRules,
  cacheTokenDigest,
  cacheTokenVerifier,
  maxCacheTokenBytes,
  minCacheTokenBytes,
  retentionCron,
  workerStageOptions
} from "../../deployment.ts"
import { retentionDays } from "../index.ts"

const readToken = "SMITHERS_CACHE_READ_TOKEN"

const configured = (value: string): Promise<string> =>
  Effect.runPromise(
    Effect.provide(
      Effect.map(cacheTokenVerifier(readToken), Redacted.value),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: value }))
    )
  )

describe("cache credential verification", () => {
  it("hands the Worker a digest rather than the credential", async () => {
    const token = "x".repeat(minCacheTokenBytes)

    expect(cacheTokenDigest(readToken, token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"))
    await expect(configured(token)).resolves.toBe(createHash("sha256").update(token, "utf8").digest("hex"))
  })

  it("refuses a credential that is too short, too long, or not printable ASCII", () => {
    const cases = [
      "x".repeat(minCacheTokenBytes - 1),
      "x".repeat(maxCacheTokenBytes + 1),
      `${"x".repeat(minCacheTokenBytes)} withspace`,
      `${"x".repeat(minCacheTokenBytes)}\u0000`,
      `${"x".repeat(minCacheTokenBytes)}é`,
      ""
    ]

    for (const value of cases) {
      expect(() => cacheTokenDigest(readToken, value)).toThrow(readToken)
    }
  })

  it("fails the deployment rather than deploying with one credential", async () => {
    // A Worker that received only one secret would answer every request from
    // whichever half was configured, which is the posture the split ends.
    await expect(
      Effect.runPromise(
        Effect.provide(
          cacheTokenVerifier("SMITHERS_CACHE_WRITE_TOKEN"),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: "x".repeat(minCacheTokenBytes) }))
        )
      )
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        Effect.provide(
          cacheTokenVerifier(readToken),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ [readToken]: "short" }))
        )
      )
    ).rejects.toThrow(readToken)
  })

  it("gives production the custom domain and every other stage a workers.dev URL", () => {
    expect(workerStageOptions("prod")).toEqual({ domain: "build.smithers.sh", workersDev: false })
    expect(workerStageOptions("dev_alice")).toEqual({ workersDev: true })
    expect(workerStageOptions("production")).toEqual({ workersDev: true })
  })

  it("exposes the credential as a Config so a deployment reads it from the environment", () => {
    expect(Config.isConfig(cacheTokenVerifier(readToken))).toBe(true)
  })

  it("keeps retention policy internally bounded and ordered", () => {
    const ids = artifactLifecycleRules.map((rule) => rule.id)
    const maxAges = artifactLifecycleRules.map((rule) =>
      "deleteObjectsTransition" in rule
        ? rule.deleteObjectsTransition.condition.maxAge
        : rule.abortMultipartUploadsTransition.condition.maxAge
    )
    const artifactRule = artifactLifecycleRules.find((rule) => rule.id === "expire-cache-artifacts")
    const artifactMaxAge = artifactRule !== undefined && "deleteObjectsTransition" in artifactRule
      ? artifactRule.deleteObjectsTransition.condition.maxAge
      : 0

    expect(new Set(ids).size).toBe(ids.length)
    expect(maxAges.every((maxAge) => Number.isInteger(maxAge) && maxAge > 0)).toBe(true)
    expect(artifactMaxAge).toBeGreaterThan(retentionDays * 24 * 60 * 60)
    expect(retentionCron.trim().split(/\s+/)).toHaveLength(5)
  })

  it("wires retention, credentials, and Worker entry paths into the deployment", async () => {
    const source = await Fs.readFile(fileURLToPath(new URL("../../alchemy.run.ts", import.meta.url).href), "utf8")

    expect(source).toContain("crons: [retentionCron]")
    expect(source).toContain("lifecycleRules: [...artifactLifecycleRules]")
    expect(source).toContain("CACHE_READ_TOKEN: cacheTokenVerifier(\"SMITHERS_CACHE_READ_TOKEN\")")
    expect(source).toContain("CACHE_WRITE_TOKEN: cacheTokenVerifier(\"SMITHERS_CACHE_WRITE_TOKEN\")")
    expect(source).toContain("main: \"./worker/index.ts\"")
    expect(source).toContain("migrationsDir: \"./worker/migrations\"")
  })
})

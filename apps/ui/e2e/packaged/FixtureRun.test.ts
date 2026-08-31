import { afterEach, describe, expect, test } from "bun:test"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PackagedFixtureRun } from "./FixtureRun"

const roots: Array<string> = []

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "smithers-fixture-run-test-"))
  roots.push(root)
  return root
}

const exists = (path: string): Promise<boolean> =>
  access(path, constants.F_OK).then(() => true, () => false)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("the packaged E2E fixture lease", () => {
  test("removes a test directory before clearing its marker and accepts the next test", async () => {
    const registry = await scratch()
    const run = await PackagedFixtureRun.start({ registryDirectory: registry })
    const first = await run.beginTest("first")
    const payload = await first.makeDirectory("payload")
    await writeFile(join(payload, "value.txt"), "real fixture data")

    expect(await exists(join(registry, "active", "active-test.json"))).toBe(true)
    expect(await readFile(join(payload, "value.txt"), "utf8")).toBe("real fixture data")
    await first.cleanup()
    expect(await exists(first.directory)).toBe(false)
    expect(await exists(join(registry, "active", "active-test.json"))).toBe(false)

    const second = await run.beginTest("second")
    await second.cleanup()
    await run.cleanup()
    expect(await exists(join(registry, "active"))).toBe(false)
  })

  test("refuses to start a new test when the prior test never cleaned up", async () => {
    const registry = await scratch()
    const run = await PackagedFixtureRun.start({ registryDirectory: registry })
    const leaked = await run.beginTest("leaked test")

    expect(run.beginTest("must not run")).rejects.toThrow("cleanup never completed for prior test")
    await leaked.cleanup()
    await run.cleanup()
  })

  test("rejects a concurrent live suite without touching its fixtures", async () => {
    const registry = await scratch()
    const first = await PackagedFixtureRun.start({ registryDirectory: registry })
    const fixture = await first.beginTest("live")
    await writeFile(join(fixture.directory, "sentinel"), "keep")

    expect(PackagedFixtureRun.start({ registryDirectory: registry })).rejects.toThrow(
      "Another packaged E2E run is active"
    )
    expect(await readFile(join(fixture.directory, "sentinel"), "utf8")).toBe("keep")
    await fixture.cleanup()
    await first.cleanup()
  })

  test("detects, reports, repairs, and fails once after a crashed prior suite", async () => {
    const registry = await scratch()
    const artifacts = join(registry, "artifacts")
    const crashed = await PackagedFixtureRun.start({ registryDirectory: registry })
    const leaked = await crashed.beginTest("process was killed")
    await writeFile(join(leaked.directory, "orphan"), "stale")

    expect(PackagedFixtureRun.start({
      registryDirectory: registry,
      artifactsDirectory: artifacts,
      isProcessAlive: () => false
    })).rejects.toThrow("Detected an unclean prior packaged E2E run")
    expect(await exists(join(registry, "active"))).toBe(false)
    expect((await Array.fromAsync(new Bun.Glob("stale-fixture-*.json").scan(artifacts))).length).toBe(1)

    const clean = await PackagedFixtureRun.start({ registryDirectory: registry })
    await clean.cleanup()
  })

  test("can explicitly repair a stale or half-written lease and continue in one invocation", async () => {
    const registry = await scratch()
    await mkdir(join(registry, "active"), { recursive: true })
    await writeFile(join(registry, "active", "lease.json"), "not json")
    await writeFile(join(registry, "active", "orphan"), "stale")

    const recovered = await PackagedFixtureRun.start({
      registryDirectory: registry,
      allowStaleRecovery: true,
      isProcessAlive: () => false
    })
    const fixture = await recovered.beginTest("after recovery")
    await fixture.cleanup()
    await recovered.cleanup()
  })
})

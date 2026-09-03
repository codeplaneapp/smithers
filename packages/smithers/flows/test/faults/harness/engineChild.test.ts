import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { probeEngineChild, spawnEngineChild } from "./engineChild.ts"
import { killResumeFixture } from "./killResumeCase.ts"
import { markers } from "./killResumeFlow.ts"

const fixture = killResumeFixture("child-protocol", 10)
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }))

describe("the engine child-runner protocol", () => {
  it("admits itself with a probe that runs no flow", async () => {
    const child = spawnEngineChild({ ...fixture, executionId: "probe-1", mode: "probe" })
    expect(await child.exited).toBe(0)
    // The handshake names the phase and echoes the nonce this spawn minted, so
    // a long-lived process cannot pass admission by claiming a name.
    expect(child.stdout()).toContain(`SMITHERS_ENGINE_HANDSHAKE=probe:${child.nonce}`)
    expect(child.stdout()).toContain("PROBE_STATUS=ok")
    // A probe proves the runner boots the product and nothing else: no markers,
    // no counter lines, no execution.
    expect(fixture.counter()).toEqual([])
    expect(fixture.marker(markers.firstDone)).toBeUndefined()
  }, 120_000)

  it("uses a different handshake phase for an execution, so a probe cannot be replayed as one", async () => {
    const child = spawnEngineChild({ ...fixture, executionId: "execute-1", mode: "execute" })
    expect(await child.exited).toBe(0)
    expect(child.stdout()).toContain(`SMITHERS_ENGINE_HANDSHAKE=execute:${child.nonce}`)
    expect(child.stdout()).not.toContain("SMITHERS_ENGINE_HANDSHAKE=probe:")
    expect(child.stdout()).toContain("RESULT_STATUS=succeeded")
    // This time it really ran: both actions dispatched, both markers written.
    expect(fixture.counter()).toEqual(["first", "second"])
    expect(fixture.marker(markers.secondDone)).toBeDefined()
  }, 120_000)

  it("rejects a probe against an unusable database rather than reporting ok", async () => {
    await expect(
      probeEngineChild({ ...fixture, filename: "/dev/null/not-a-directory/run.sqlite", executionId: "probe-2" })
    ).rejects.toThrow(/admission probe failed/)
  }, 120_000)
})

import { describe, expect, test } from "bun:test"
import type { BootSession } from "./BootSession"
import { createControllerBoot } from "./ControllerBootMemo"
import type { AppController } from "./state/AppController"

/*
 * The boot memo used to pin the FIRST session forever: a module-scope promise
 * cached without a key, so a second session silently inherited the first
 * session's controller. The memo is now keyed on the session — a new session
 * boots a new controller, a stable session keeps its boot.
 */

const sessionA: BootSession = { state: "signed-in", login: "a", allowlisted: true, admin: false, authFailed: false }
const sessionB: BootSession = { state: "signed-out", login: null, allowlisted: false, admin: false, authFailed: false }

describe("createControllerBoot", () => {
  test("a stable session reuses its boot", () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.resolve({ tag: loads } as unknown as AppController)
    })
    const first = boot(sessionA)
    expect(boot(sessionA)).toBe(first)
    expect(loads).toBe(1)
  })

  test("a new session boots a new controller instead of pinning the first", async () => {
    let loads = 0
    const boot = createControllerBoot((session) => {
      loads += 1
      return Promise.resolve({ tag: loads, login: session?.login ?? null } as unknown as AppController)
    })
    const first = boot(sessionA)
    const second = boot(sessionB)
    expect(second).not.toBe(first)
    expect(loads).toBe(2)
    expect(((await first) as unknown as { login: string | null }).login).toBe("a")
    expect(((await second) as unknown as { login: string | null }).login).toBeNull()
    // The first session's boot is not displaced retroactively: asking again
    // for the CURRENT session reuses the current boot.
    expect(boot(sessionB)).toBe(second)
  })

  test("an absent session (the Vite dev entry) is its own key", () => {
    let loads = 0
    const boot = createControllerBoot(() => {
      loads += 1
      return Promise.resolve({ tag: loads } as unknown as AppController)
    })
    expect(boot()).toBe(boot())
    expect(loads).toBe(1)
  })
})

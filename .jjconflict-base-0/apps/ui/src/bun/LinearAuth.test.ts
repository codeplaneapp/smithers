import { describe, expect, test } from "bun:test"
import { createLinearAuth } from "./LinearAuth"

/*
 * The Linear OAuth handoff (lane sync, ADR 0005): start answers the OAuth
 * URL through the local cloud proxy with callback_port attached; the first
 * well-formed callback claims the attempt and the session answers the setup
 * key; a replay answers 409; a new start supersedes a stale key.
 */

const auth = (options: { readonly waitTimeoutMs?: number } = {}) =>
  createLinearAuth({ origin: () => "http://127.0.0.1:9999", log: () => {}, ...options })

const callbackPort = (url: string): string => new URL(url).searchParams.get("callback_port") ?? ""

describe("the Linear OAuth handoff on the local origin", () => {
  test("start answers the proxied OAuth URL with callback_port, idle until then", async () => {
    const handoff = auth()
    expect(handoff.session()).toEqual({ state: "idle" })
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const parsed = new URL(started.url)
    expect(`${parsed.origin}${parsed.pathname}`).toBe("http://127.0.0.1:9999/api/cloud/api/auth/linear")
    expect(callbackPort(started.url)).not.toBe("")
    expect(handoff.session()).toEqual({ state: "waiting" })
    await handoff.stop()
  })

  test("the callback records the setup key and the session answers it, once", async () => {
    const handoff = auth()
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const port = callbackPort(started.url)
    const page = await fetch(`http://127.0.0.1:${port}/callback?setup=setup-key-1`)
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain("return to Smithers")
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "setup-key-1" })
    // A replay can no longer substitute the key.
    const replay = await fetch(`http://127.0.0.1:${port}/callback?setup=setup-key-2`)
    expect(replay.status).toBe(409)
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "setup-key-1" })
    await handoff.stop()
  })

  test("a callback without a setup key is refused, and other paths 404", async () => {
    const handoff = auth()
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    const port = callbackPort(started.url)
    expect((await fetch(`http://127.0.0.1:${port}/callback`)).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere?setup=x`)).status).toBe(404)
    expect(handoff.session()).toEqual({ state: "waiting" })
    await handoff.stop()
  })

  test("a new start supersedes a stale key and the old listener dies", async () => {
    const handoff = auth()
    const first = await handoff.start()
    if ("error" in first) throw new Error(first.error)
    const firstPort = callbackPort(first.url)
    await fetch(`http://127.0.0.1:${firstPort}/callback?setup=stale`)
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "stale" })
    const second = await handoff.start()
    if ("error" in second) throw new Error(second.error)
    expect(handoff.session()).toEqual({ state: "waiting" })
    // The first listener is closed; its port answers nothing now.
    await expect(fetch(`http://127.0.0.1:${firstPort}/callback?setup=stale-2`)).rejects.toThrow()
    const secondPort = callbackPort(second.url)
    await fetch(`http://127.0.0.1:${secondPort}/callback?setup=fresh`)
    expect(handoff.session()).toEqual({ state: "authorized", setupKey: "fresh" })
    await handoff.stop()
  })

  test("an expired attempt returns to idle", async () => {
    const handoff = auth({ waitTimeoutMs: 20 })
    const started = await handoff.start()
    if ("error" in started) throw new Error(started.error)
    expect(handoff.session()).toEqual({ state: "waiting" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(handoff.session()).toEqual({ state: "idle" })
    await handoff.stop()
  })
})

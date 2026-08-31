import { describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { launchApp } from "./PackagedApp"
import type { PackagedApp } from "./PackagedApp"

const executable = process.env.SMITHERS_E2E_EXECUTABLE
const artifactsDirectory = process.env.SMITHERS_E2E_ARTIFACTS
const enabled = process.platform === "darwin" && executable !== undefined && artifactsDirectory !== undefined

const withApp = async (label: string, run: (app: PackagedApp) => Promise<void>): Promise<void> => {
  if (executable === undefined || artifactsDirectory === undefined) {
    throw new Error(
      "Run this suite through `bun run test:e2e` so it receives a packaged executable and artifact directory."
    )
  }
  const app = await launchApp({ executable, artifactsDirectory })
  try {
    await app.ready()
    await run(app)
  } catch (error) {
    await app.captureDiagnostics(label)
    throw error
  } finally {
    await app.cleanup()
  }
}

interface RenderedShell {
  readonly title: string
  readonly bodyTextLength: number
  readonly htmlLength: number
  readonly composer: boolean
  readonly transcript: boolean
}

const renderedShell = `
  ({
    title: document.title,
    bodyTextLength: document.body?.innerText.length ?? 0,
    htmlLength: document.documentElement.outerHTML.length,
    composer: document.querySelector('[data-testid="composer-input"]') instanceof HTMLTextAreaElement,
    transcript: document.querySelector('[data-testid="transcript"]') instanceof HTMLElement
  })
`

const sendMessage = async (app: PackagedApp, text: string): Promise<void> => {
  const encoded = JSON.stringify(text)
  await app.eval<boolean>(`
    (() => {
      const input = document.querySelector('[data-testid="composer-input"]')
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('composer input is missing')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setter === undefined) throw new Error('textarea value setter is missing')
      setter.call(input, ${encoded})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await app.waitFor<boolean>(`
    (() => {
      const send = document.querySelector('[data-testid="composer-send"]')
      return send instanceof HTMLButtonElement && !send.disabled
    })()
  `)
  await app.eval<boolean>(`
    (() => {
      const send = document.querySelector('[data-testid="composer-send"]')
      if (!(send instanceof HTMLButtonElement)) throw new Error('composer send button is missing')
      send.click()
      return true
    })()
  `)
}

const transcriptContains = (text: string): string => `
  Array.from(document.querySelectorAll('.smithers-chat-message'))
    .some((element) => element.textContent?.includes(${JSON.stringify(text)}) === true)
`

describe.skipIf(!enabled)("the packaged production Electrobun app", () => {
  test("launches the stable native renderer and exposes only an authenticated bridge", async () => {
    await withApp("launch", async (app) => {
      const state = await app.state()
      expect(state.app).toMatchObject({ packaged: true, channel: "stable", defaultRenderer: "native" })
      expect(state.window).toMatchObject({ renderer: "native", url: state.app.origin + "/" })
      expect(await app.unauthorizedStatus()).toBe(401)

      const shell = await app.waitFor<RenderedShell>(renderedShell, (value) => value.composer && value.transcript)
      expect(shell.title).toMatch(/Smithers/i)
      expect(shell.bodyTextLength).toBeGreaterThan(200)
      expect(shell.htmlLength).toBeGreaterThan(2_000)

      // This value returns through Electrobun's real Bun -> WebView RPC, not CDP.
      expect(await app.eval<number>("document.querySelectorAll('button').length")).toBeGreaterThan(3)
      let evalError = ""
      try {
        await app.eval("(() => { throw new Error('expected renderer failure') })()")
      } catch (error) {
        evalError = String(error)
      }
      expect(evalError).toContain("expected renderer failure")
      expect(await app.eval<number>("6 * 7")).toBe(42)

      // Capture is useful where macOS Screen Recording permission is present,
      // but lack of that permission must not make the app workflow flaky.
      const screenshot = await app.screenshot("launch.png").catch((error) => {
        expect(String(error)).toContain("screenshot_unavailable")
        return undefined
      })
      if (screenshot !== undefined) expect((await stat(screenshot)).size).toBeGreaterThan(100)
    })
  })

  test("round-trips chat, recovers from a rejected mutation, and persists through relaunch", async () => {
    await withApp("chat-persistence", async (app) => {
      const firstState = await app.state()
      const unauthorizedMutation = await app.eval<number>(`
        fetch(${JSON.stringify(`${firstState.app.origin}/api/chat/cancel`)}, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: 'unauthorized-e2e-probe' })
        }).then((response) => response.status)
      `)
      expect(unauthorizedMutation).toBe(401)

      const message = `packaged app e2e ${Date.now()}-${Math.random().toString(16).slice(2)}`
      await sendMessage(app, message)
      expect(await app.waitFor<boolean>(transcriptContains(message))).toBe(true)
      expect(await app.waitFor<boolean>(transcriptContains(`stub: ${message}`), (value) => value, 30_000)).toBe(true)

      await app.relaunch()
      const relaunchedState = await app.state()
      expect(relaunchedState.app.origin).toBe(firstState.app.origin)
      expect(relaunchedState.app.pid).not.toBe(firstState.app.pid)
      expect(await app.waitFor<boolean>(transcriptContains(message), (value) => value, 30_000)).toBe(true)
      expect(await app.waitFor<boolean>(transcriptContains(`stub: ${message}`), (value) => value, 30_000)).toBe(true)
    })
  })
})

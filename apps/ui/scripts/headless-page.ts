/*
 * Launch checklist (U7) — the real headless page driver.
 *
 * Implements src/launch-checklist/Types.ts's ProbePage over the Chrome
 * DevTools protocol against a system Chrome, the same way
 * scripts/web-chat-e2e.ts already drives the app. No Playwright, no download,
 * no new dependency: a checklist run either finds a browser or the browser
 * rows honestly report not-testable-yet.
 *
 * One browser is launched per run and one page is opened per distinct session
 * cookie, so a full §A-F pass costs one process, not thirty.
 */
import { existsSync } from "node:fs"
import { browserArgv, findBrowser, newTargetUrl, NO_BROWSER_REASON } from "../src/launch-checklist/BrowserLaunch.ts"
import { BrowserUnavailableError, type ProbePage } from "../src/launch-checklist/Types.ts"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  close(): void
}

const connect = async (socketUrl: string): Promise<CdpConnection> => {
  const socket = new WebSocket(socketUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () => reject(new Error(`could not open a CDP socket at ${socketUrl}`)))
  })
  let nextId = 0
  const pending = new Map<number, (result: unknown) => void>()
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
    if (message.id === undefined) return
    pending.get(message.id)?.(message.error ? { cdpError: message.error.message } : message.result)
    pending.delete(message.id)
  })
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = (nextId += 1)
        pending.set(id, resolve)
        socket.send(JSON.stringify({ id, method, params }))
      }),
    close: () => socket.close()
  }
}

/** One named key press, as real key events. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  "/": { key: "/", code: "Slash", keyCode: 191, text: "/" }
}

export interface HeadlessBrowser {
  /** A page on `target` carrying `cookie`, cached per cookie for the run. */
  page(cookie: string | undefined): Promise<ProbePage>
  close(): Promise<void>
}

export interface HeadlessBrowserOptions {
  readonly target: string
  readonly explicitBinary: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly port?: number
}

export const createHeadlessBrowser = ({
  target,
  explicitBinary,
  env,
  port = 9444
}: HeadlessBrowserOptions): HeadlessBrowser => {
  const binary = findBrowser({ explicit: explicitBinary, env, exists: existsSync })
  const pages = new Map<string, Promise<ProbePage>>()
  let process: { kill(): void } | undefined
  const connections: Array<CdpConnection> = []

  const launchOnce = (): void => {
    if (process !== undefined || binary === undefined) return
    process = Bun.spawn(
      [...browserArgv(binary, port, `${env.TMPDIR ?? "/tmp"}/smithers-launch-checklist-profile`)],
      { stdout: "ignore", stderr: "ignore" }
    )
  }

  const openTarget = async (): Promise<CdpConnection> => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(newTargetUrl(port, "about:blank"), { method: "PUT" })
        const descriptor = (await response.json()) as { webSocketDebuggerUrl?: string }
        if (descriptor.webSocketDebuggerUrl !== undefined) return await connect(descriptor.webSocketDebuggerUrl)
      } catch {
        // Chrome is still starting up.
      }
      await wait(250)
    }
    throw new BrowserUnavailableError(`the browser at ${binary} never exposed a DevTools endpoint on port ${port}`)
  }

  const createPage = async (cookie: string | undefined): Promise<ProbePage> => {
    launchOnce()
    const cdp = await openTarget()
    connections.push(cdp)
    await cdp.send("Page.enable")
    await cdp.send("Runtime.enable")
    await cdp.send("Network.enable")
    if (cookie !== undefined) await cdp.send("Network.setExtraHTTPHeaders", { headers: { cookie } })
    // A fresh slate: a previous run's persisted transcript must never be read as this run's.
    await cdp.send("Storage.clearDataForOrigin", {
      origin: new URL(target).origin,
      storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers"
    })
    const evaluate = async <T>(expression: string): Promise<T> => {
      const answer = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (answer?.exceptionDetails !== undefined) {
        throw new Error(`page evaluation failed: ${JSON.stringify(answer.exceptionDetails).slice(0, 300)}`)
      }
      return answer?.result?.value as T
    }
    const navigate = async (): Promise<void> => {
      await cdp.send("Page.navigate", { url: target })
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const ready = await evaluate<boolean>(`document.readyState === "complete"`).catch(() => false)
        if (ready === true) return
        await wait(250)
      }
    }
    await navigate()
    const dispatch = async (
      descriptor: { key: string; code: string; keyCode: number; text?: string }
    ): Promise<void> => {
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: descriptor.key,
          code: descriptor.code,
          windowsVirtualKeyCode: descriptor.keyCode,
          nativeVirtualKeyCode: descriptor.keyCode,
          ...(type === "keyDown" && descriptor.text !== undefined ? { text: descriptor.text } : {})
        })
      }
    }
    return {
      text: () => evaluate<string>("document.body.innerText"),
      evaluate,
      type: async (value: string) => {
        for (const character of value) {
          await dispatch({
            key: character,
            code: `Key${character.toUpperCase()}`,
            keyCode: character.charCodeAt(0),
            text: character
          })
        }
      },
      press: async (key: string) => {
        const descriptor = KEYS[key]
        if (descriptor === undefined) throw new Error(`no key descriptor for ${key}`)
        await dispatch(descriptor)
      },
      reload: navigate
    }
  }

  return {
    page: (cookie) => {
      if (binary === undefined) return Promise.reject(new BrowserUnavailableError(NO_BROWSER_REASON))
      const key = cookie ?? "(signed-out)"
      const existing = pages.get(key)
      if (existing !== undefined) return existing
      const created = createPage(cookie)
      pages.set(key, created)
      return created
    },
    close: async () => {
      for (const connection of connections) connection.close()
      process?.kill()
    }
  }
}

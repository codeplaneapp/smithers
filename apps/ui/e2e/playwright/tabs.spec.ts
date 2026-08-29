import { expect, test } from "@playwright/test"
import type { Page, Request, WebSocketRoute } from "@playwright/test"

/*
 * Lane L2 (docs/LOCAL-APP.md "Tabs", "Cards"): the strip, the `+` menu, the
 * terminal over the PTY topics, card tabs, and the keyboard bindings.
 *
 * The server is a double: every HTTP seam the chrome touches answers through
 * page.route, and `/ws` through page.routeWebSocket, so the spec proves the
 * SPA's side of the contract and keeps passing unchanged once the real
 * `bun src/bun/serve.ts` stands behind the same paths.
 */

const HARNESSES = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "/opt/homebrew/bin/claude",
    version: "2.1.0",
    status: "signed-in",
    account: { email: "will@codeplane.app" },
    launch: { argv: ["claude"] }
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "/opt/homebrew/bin/codex",
    version: "0.50.0",
    status: "api-key",
    account: { label: "OPENAI_API_KEY" },
    launch: { argv: ["codex"] }
  },
  {
    id: "gemini",
    displayName: "Gemini",
    binary: null,
    version: null,
    status: "unavailable",
    account: null,
    launch: { argv: ["gemini"] }
  }
]

const FORCE_REPO = {
  id: "force",
  path: "/Users/williamcory/artsy/force",
  name: "artsy/force",
  git: { branch: "main", remote: "git@github.com:artsy/force.git" },
  smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: ["WORKSPACE.ts"], reason: "ok" }
}

const SESSION_ID = "pty-1"

interface ServerDouble {
  /** Every `POST /api/pty` body, in order. */
  readonly created: Array<Record<string, unknown>>
  /** Every `DELETE /api/pty/:id` id, in order. */
  readonly deleted: Array<string>
  /** Every `pty.input` frame's data, concatenated in arrival order. */
  readonly typed: () => string
  /** The `/ws` routes that opened. */
  readonly sockets: Array<WebSocketRoute>
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double. `repos` is what `GET /api/repos` answers. */
const serve = async (page: Page, repos: ReadonlyArray<unknown> = []): Promise<ServerDouble> => {
  const created: Array<Record<string, unknown>> = []
  const deleted: Array<string> = []
  const inputs: Array<string> = []
  const sockets: Array<WebSocketRoute> = []

  // The last route registered wins, so the catch-all goes first: every seam
  // the chrome does not mock answers as absent, never as the SPA's own HTML.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404)))
  await page.route("**/api/harnesses", (route) => route.fulfill(json({ harnesses: HARNESSES })))
  await page.route("**/api/repos", (route) => route.fulfill(json({ repos })))
  await page.route("**/api/pty", (route) => {
    if (route.request().method() !== "POST") return route.fulfill(json({ sessions: [] }))
    created.push(route.request().postDataJSON() as Record<string, unknown>)
    return route.fulfill(json({ sessionId: SESSION_ID }))
  })
  await page.route(`**/api/pty/${SESSION_ID}/resize`, (route) => route.fulfill(json({ ok: true })))
  await page.route(`**/api/pty/${SESSION_ID}`, (route) => {
    if (route.request().method() === "DELETE") deleted.push(SESSION_ID)
    return route.fulfill(json({ ok: true }))
  })
  await page.routeWebSocket("**/ws", (socket) => {
    sockets.push(socket)
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type: string; topic?: string; sessionId?: string; data?: string }
      if (frame.type === "subscribe" && frame.topic === `pty:${SESSION_ID}`) {
        socket.send(JSON.stringify({ type: "pty.output", sessionId: SESSION_ID, data: "hello from pty\r\n" }))
      }
      if (frame.type === "pty.input" && frame.sessionId === SESSION_ID) inputs.push(frame.data ?? "")
    })
  })
  return { created, deleted, typed: () => inputs.join(""), sockets }
}

const isPtyCreate = (request: Request): boolean => request.method() === "POST" && /\/api\/pty$/.test(request.url())

/** Open a terminal tab through the `+` menu and wait for its emulator; the tab id is the session id. */
const openTerminal = async (page: Page): Promise<string> => {
  const creating = page.waitForRequest(isPtyCreate)
  await page.getByTestId("tab-add").click()
  await page.getByTestId("tab-add-terminal").click()
  await creating
  const tabId = SESSION_ID
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`terminal-${SESSION_ID}`)).toBeVisible()
  return tabId
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry tabs across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("the strip boots with the main tab and the + button alone", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  const strip = page.getByTestId("tab-strip")
  await expect(strip).toBeVisible()
  await expect(page.getByTestId("tab-main")).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId("tab-add")).toBeVisible()
  await expect(strip.locator(".tab")).toHaveCount(1)
  // Main is not closable.
  await expect(page.getByTestId("tab-close-main")).toHaveCount(0)
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await expect(page.getByTestId("transcript")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  // No repository: no chip.
  await expect(page.getByTestId("repo-chip")).toHaveCount(0)
  await expect(page.getByTestId("chrome-open-repo")).toBeVisible()
  await expect(page.getByTestId("chrome-sign-in")).toBeVisible()
})

test("the repo chip names the active repository", async ({ page }) => {
  await serve(page, [FORCE_REPO])
  await page.goto("/")
  await expect(page.getByTestId("repo-chip")).toHaveText("artsy/force")
})

test("the + menu lists Terminal, then the detected harnesses with their accounts", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  await page.getByTestId("tab-add").click()
  const menu = page.getByTestId("tab-add-menu")
  await expect(menu).toBeVisible()
  await expect(page.getByTestId("tab-add-terminal")).toHaveText("Terminal")
  const claude = page.getByTestId("tab-add-harness-claude")
  await expect(claude).toContainText("Claude Code")
  await expect(claude).toContainText("will@codeplane.app")
  await expect(claude).toBeEnabled()
  const codex = page.getByTestId("tab-add-harness-codex")
  await expect(codex).toContainText("Codex")
  await expect(codex).toContainText("OPENAI_API_KEY")
  // Unavailable harnesses are listed last, disabled, with their status.
  const gemini = page.getByTestId("tab-add-harness-gemini")
  await expect(gemini).toBeDisabled()
  await expect(gemini).toContainText("unavailable")
  const items = menu.locator("[role=menuitem]")
  await expect(items.first()).toHaveText("Terminal")
  await expect(items.last()).toContainText("Gemini")
})

test("a terminal tab creates a PTY session, renders its output, and sends keystrokes", async ({ page }) => {
  const server = await serve(page)
  await page.goto("/")
  await openTerminal(page)

  expect(server.created).toHaveLength(1)
  expect(server.created[0]).toMatchObject({ kind: "terminal", cwd: "~" })
  expect(typeof server.created[0]?.cols).toBe("number")
  expect(typeof server.created[0]?.rows).toBe("number")

  // The main tab stays mounted, hidden.
  await expect(page.getByTestId("tab-body-main")).toBeHidden()
  await expect(page.getByTestId("tab-body-main")).toHaveCount(1)

  const terminal = page.getByTestId(`terminal-${SESSION_ID}`)
  await expect(terminal.locator(".xterm-rows")).toContainText("hello from pty")

  await terminal.click()
  await page.keyboard.type("ls")
  await expect.poll(() => server.typed()).toBe("ls")
})

test("Cmd+W asks before closing a live terminal, then deletes its session; main never closes", async ({ page }) => {
  const server = await serve(page)
  await page.goto("/")
  const tabId = await openTerminal(page)

  await page.keyboard.press("Meta+w")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close tab", exact: true }).click()

  await expect(page.getByTestId(`tab-${tabId}`)).toHaveCount(0)
  await expect.poll(() => server.deleted).toEqual([SESSION_ID])
  await expect(page.getByTestId("tab-main")).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId("tab-body-main")).toBeVisible()

  // Cmd+W on main: nothing to close, nothing asked.
  await page.keyboard.press("Meta+w")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByTestId("tab-main")).toBeVisible()
  await expect(page.getByTestId("tab-strip").locator(".tab")).toHaveCount(1)
})

test("Cmd+1 selects the main tab and Cmd+T opens a terminal", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  const tabId = await openTerminal(page)

  await page.keyboard.press("Meta+1")
  await expect(page.getByTestId("tab-main")).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await expect(page.getByTestId(`tab-body-${tabId}`)).toBeHidden()

  await page.keyboard.press("Meta+2")
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`tab-body-${tabId}`)).toBeVisible()
})

test("a maximized card offers Open in tab; closing the tab keeps the card", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  // /theme opens the color-theme picker card with no backend at all.
  const composer = page.getByTestId("composer-input")
  await composer.click()
  await composer.fill("/theme")
  await composer.press("Enter")
  const transcript = page.getByTestId("transcript")
  const card = transcript.getByTestId("card-theme-picker")
  await expect(card).toBeVisible()
  await expect(card.getByTestId("card-kind-theme-picker")).toBeVisible()

  // Embedded: no tab affordance. Maximized: the affordance appears.
  await expect(page.getByTestId("card-open-in-tab-theme-picker")).toHaveCount(0)
  await card.getByTestId("card-maximize-theme-picker").click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.getByTestId("card-open-in-tab-theme-picker").click()

  const tabId = "card-theme-picker"
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`tab-${tabId}`)).toContainText("Color themes")
  const body = page.getByTestId(`tab-body-${tabId}`)
  await expect(body).toBeVisible()
  await expect(body.getByTestId("card-theme-picker")).toBeVisible()
  await expect(body.getByTestId("card-theme-picker")).toHaveAttribute("data-maximized", "false")

  // Closing a card tab keeps the card in the transcript.
  await page.getByTestId(`tab-close-${tabId}`).click()
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveCount(0)
  await expect(page.getByTestId("tab-main")).toHaveAttribute("data-active", "true")
  await expect(transcript.getByTestId("card-theme-picker")).toBeVisible()
})

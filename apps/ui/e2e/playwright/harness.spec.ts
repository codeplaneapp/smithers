import { expect, test } from "@playwright/test"
import type { Response } from "@playwright/test"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/*
 * Lane L4 (docs/LOCAL-APP.md "Harness detection"): `GET /api/harnesses`
 * reports the CLIs installed on this machine with their signed-in accounts,
 * the `+` menu lists Claude Code with the account email, and opening the
 * harness tab runs `claude` under the harness sandbox policy until its
 * banner shows in the emulator.
 *
 * The signed-in assertions depend on this machine's credentials, so they
 * skip with a reason where `~/.claude.json` carries no oauthAccount.
 */

interface HarnessRow {
  id: string
  displayName: string
  binary: string | null
  version: string | null
  status: string
  account: { email?: string; label?: string } | null
  launch: { argv: Array<string> }
}

const HARNESS_IDS = ["claude", "codex", "gemini", "kimi", "opencode", "crush", "amp", "cursor-agent", "hermes", "pi"]

/** The email `~/.claude.json` says Claude Code is signed in as, or undefined. */
const claudeEmail = (): string | undefined => {
  try {
    const state = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: string } }
    const email = state.oauthAccount?.emailAddress
    return typeof email === "string" && email !== "" ? email : undefined
  } catch {
    return undefined
  }
}

const codexSignedIn = (): boolean => {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8")) as { tokens?: { id_token?: string } }
    return typeof auth.tokens?.id_token === "string"
  } catch {
    return false
  }
}

const isPtyCreate = (response: Response): boolean =>
  response.request().method() === "POST" && /\/api\/pty$/.test(response.url())

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("GET /api/harnesses lists every contract id; claude and codex are signed in on this machine", async ({ request }) => {
  const response = await request.get("/api/harnesses")
  expect(response.status()).toBe(200)
  const { harnesses } = (await response.json()) as { harnesses: Array<HarnessRow> }
  expect(harnesses.map((harness) => harness.id)).toEqual(HARNESS_IDS)
  for (const harness of harnesses) {
    expect(["signed-in", "api-key", "binary-only", "unavailable"]).toContain(harness.status)
    expect(harness.launch.argv[0]).toBe(harness.id)
    expect(harness.launch.argv).not.toContain("--dangerously-skip-permissions")
    if (harness.status === "unavailable") expect(harness.binary).toBeNull()
    else expect(harness.binary?.startsWith("/")).toBe(true)
  }
  const claude = harnesses.find((harness) => harness.id === "claude")
  const codex = harnesses.find((harness) => harness.id === "codex")
  expect(claude?.displayName).toBe("Claude Code")
  expect(codex?.displayName).toBe("Codex")

  const email = claudeEmail()
  test.skip(email === undefined, "~/.claude.json has no oauthAccount: Claude Code is not signed in on this machine")
  expect(claude).toMatchObject({ status: "signed-in", account: { email } })
  expect(claude?.version).toMatch(/^\d+\.\d+\.\d+/)
  test.skip(!codexSignedIn(), "~/.codex/auth.json has no id_token: Codex is not signed in on this machine")
  expect(codex).toMatchObject({ status: "signed-in" })
  expect(codex?.account?.email).toMatch(/@/)
})

test("the + menu lists Claude Code with the signed-in email; its tab shows the Claude Code banner", async ({ page, request }) => {
  const email = claudeEmail()
  test.skip(email === undefined, "~/.claude.json has no oauthAccount: Claude Code is not signed in on this machine")
  const { harnesses } = (await (await request.get("/api/harnesses")).json()) as { harnesses: Array<HarnessRow> }
  test.skip(harnesses.find((harness) => harness.id === "claude")?.binary === null, "claude is not installed on this machine")

  await page.goto("/")
  await page.getByTestId("tab-add").click()
  const row = page.getByTestId("tab-add-harness-claude")
  await expect(row).toContainText("Claude Code")
  await expect(row).toContainText(email ?? "")
  await expect(row).toBeEnabled()

  const creating = page.waitForResponse(isPtyCreate)
  await row.click()
  const response = await creating
  expect(response.status()).toBe(201)
  const { sessionId } = (await response.json()) as { sessionId: string }
  await expect(page.getByTestId(`tab-${sessionId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`tab-${sessionId}`)).toContainText("Claude Code")

  const listed = (await (await request.get("/api/pty")).json()) as { sessions: Array<{ sessionId: string; kind: string; harnessId?: string }> }
  expect(listed.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({ kind: "harness", harnessId: "claude" })

  // The banner: "Claude Code" next to the logo, then the version, under the harness sandbox (probed 2026-08-26).
  const terminal = page.getByTestId(`terminal-${sessionId}`)
  await expect(terminal.locator(".xterm-rows")).toContainText("Claude Code", { timeout: 30_000 })
  await expect(terminal.locator(".xterm-rows")).toContainText(/v\d+\.\d+\.\d+/, { timeout: 30_000 })

  await page.getByTestId(`tab-close-${sessionId}`).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close tab", exact: true }).click()
  await expect(page.getByTestId(`tab-${sessionId}`)).toHaveCount(0)
  await expect
    .poll(async () => {
      const { sessions } = (await (await request.get("/api/pty")).json()) as { sessions: Array<{ sessionId: string }> }
      return sessions.some((session) => session.sessionId === sessionId)
    }, { timeout: 15_000 })
    .toBe(false)
})

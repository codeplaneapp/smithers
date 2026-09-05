import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

/*
 * Lane piper T1 (docs/workbench-lanes/piper.md "Exit", ADR 0001): the app
 * opens ~/smithers, the sidebar shows it UNDER its repository in the
 * org/ → repo → working copies tree (its remote parses into the cloud
 * inventory), /files.read README.md renders the card, and the card header
 * carries the global address and the position the read was taken at.
 *
 * The server is a double (tabs.spec.ts's pattern): every seam answers
 * through page.route — the local repos read, the cloud session, the Smithers Cloud
 * inventory behind /api/cloud/*, and the repo-files read.
 */

const SMITHERS_REPO = {
  id: "smithers",
  path: "/Users/williamcory/smithers",
  name: "smithers",
  git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
  jj: { changeId: "kxyzqrpv", commitId: "c0ffee123456", ahead: 3, bookmark: "main" },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: "WORKSPACE.ts",
    declarationFiles: ["WORKSPACE.ts"],
    reason: "ok",
    workspaces: [{ path: ".", title: "smithers" }]
  }
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: ~/smithers open locally, signed in to a cloud that inventories smithersai/smithers. */
const serve = async (page: Page): Promise<void> => {
  // The last route registered wins, so the catch-all goes first.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404)))
  await page.route("**/api/bootstrap", (route) => route.fulfill(json({
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "test",
    capabilities: ["agent", "identity", "cloud", "local.repositories", "local.targets", "local.terminal", "local.harnesses"],
    authFlow: "none",
    sandbox: { platform: "darwin", mode: "trusted-only" }
  })))
  await page.route("**/api/repos", (route) => route.fulfill(json({ repos: [SMITHERS_REPO] })))
  await page.route("**/api/cloud-auth/session", (route) =>
    route.fulfill(json({ state: "signed-in", username: "will", expiresAt: "2027-01-01T00:00:00.000Z" })))
  await page.route("**/api/cloud/api/user/repos", (route) =>
    route.fulfill(json({
      repos: [{ owner: "smithersai", name: "smithers", full_name: "smithersai/smithers", default_bookmark: "main" }]
    })))
  await page.route("**/api/cloud/api/user/orgs", (route) => route.fulfill(json({ orgs: [{ login: "smithersai" }] })))
  await page.route("**/api/cloud/api/repos/smithersai/smithers/bookmarks", (route) =>
    route.fulfill(json({
      bookmarks: [{ name: "main", target_change_id: "kxyzqrpv", target_commit_id: "c0ffee123456" }]
    })))
  await page.route("**/api/cloud/api/user/workspaces", (route) => route.fulfill(json({ workspaces: [] })))
  await page.route("**/api/repo/files", (route) =>
    route.fulfill(json({ kind: "file", path: "README.md", size: 10, content: "# Smithers\n", truncated: false, binary: false })))
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: ~/smithers nests under its repo in the tree; /files.read's card header shows the address and readAt", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  // The tree: org header, the repository row, and the local checkout nested
  // beneath it with its jj ahead count — never a standalone local row.
  await expect(page.getByTestId("repo-org-smithersai")).toHaveText("smithersai/")
  await expect(page.getByTestId("repo-smithersai/smithers")).toBeVisible()
  await expect(page.getByTestId("repo-local:/Users/williamcory/smithers")).toHaveCount(0)
  const copy = page.getByTestId("copy-local:/Users/williamcory/smithers")
  await expect(copy).toBeVisible()
  await expect(copy).toContainText("smithers · 3 ahead")

  // The composer's origin chip reads `~/smithers · 3 ahead of main`.
  await expect(page.getByTestId("repo-chip")).toContainText("~/smithers · 3 ahead of main")

  // /files.read renders the file card; its header carries the global address
  // and the change id the read was taken at.
  await page.getByTestId("composer-input").fill("/files.read README.md")
  await page.getByTestId("composer-send").click()
  // The card is keyed by the local checkout's name; its header carries the global address.
  const card = page.getByTestId("card-file-smithers-README.md")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator(".world-card-path")).toContainText("/smithersai/smithers/README.md")
  await expect(card.locator(".world-card-path")).toContainText("kxyzqrpv")
  // Markdown renders through the read-only editor: the heading text, not the raw fence.
  await expect(card).toContainText("Smithers")
})

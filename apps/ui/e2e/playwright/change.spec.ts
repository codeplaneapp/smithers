import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

/*
 * Lane change T1 (docs/workbench-lanes/change.md "Exit", ADR 0003): against
 * a fake cloud upstream the app opens a landing request's change end to end —
 * the change card carries the DTO, the stat, the stack position, and the
 * checks; the History facet says the revision history isn't recorded yet
 * (plue#450), never a fake rev count; the diff card renders parent → current
 * pinned at the change's commit; and a degraded sign-in reads the change
 * freely but is refused an agent dispatch with the exact enable wording.
 *
 * The server is a double (citc.spec.ts's pattern): every seam answers
 * through page.route behind /api/cloud/*.
 */

const REPO = "smithersai/smithers"

const CHANGE = {
  change_id: "qupxosqw",
  commit_id: "a03f5f1111111111",
  description: "Add the split flow\n\nLong body.",
  author_name: "will",
  author_email: "will@example.com",
  timestamp: "2026-09-01T10:00:00Z",
  has_conflict: false,
  is_empty: false,
  parent_change_ids: ["mzxvbnmk"]
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in to a cloud that inventories smithersai/smithers. */
const serve = async (
  page: Page,
  options: { readonly degraded?: boolean } = {}
): Promise<void> => {
  // The last route registered wins, so the catch-all goes first.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404)))
  await page.route("**/api/bootstrap", (route) => route.fulfill(json({
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "test",
    capabilities: ["agent", "identity", "jjhub", "local.repositories", "local.targets", "local.terminal", "local.harnesses"],
    authFlow: "none",
    sandbox: { platform: "darwin", mode: "trusted-only" }
  })))
  await page.route("**/api/repos", (route) => route.fulfill(json({ repos: [] })))
  await page.route("**/api/cloud-auth/session", (route) =>
    route.fulfill(json({
      state: "signed-in",
      username: "will",
      expiresAt: "2027-01-01T00:00:00.000Z",
      ...(options.degraded === true ? { scopes: "degraded" } : {})
    })))
  await page.route("**/api/cloud/api/user/repos", (route) =>
    route.fulfill(json({ repos: [{ owner: "smithersai", name: "smithers", full_name: REPO, default_bookmark: "main" }] })))
  await page.route("**/api/cloud/api/user/orgs", (route) => route.fulfill(json({ orgs: [{ login: "smithersai" }] })))
  await page.route(/\/api\/cloud\/api\/user\/workspaces(\?.*)?$/, (route) => route.fulfill(json([])))
  await page.route(`**/api/cloud/api/repos/${REPO}/bookmarks`, (route) =>
    route.fulfill(json({
      items: [{ name: "main", target_change_id: "kxyzqrpv", target_commit_id: "c0ffee123456", is_tracking_remote: false }],
      next_cursor: ""
    })))
  /* The change's own routes. */
  await page.route(`**/api/cloud/api/repos/${REPO}/changes/qupxosqw`, (route) => route.fulfill(json(CHANGE)))
  await page.route(`**/api/cloud/api/repos/${REPO}/changes/qupxosqw/conflicts`, (route) => route.fulfill(json([])))
  await page.route(`**/api/cloud/api/repos/${REPO}/changes/qupxosqw/diff`, (route) =>
    route.fulfill(json({
      change_id: "qupxosqw",
      file_diffs: [
        { path: "src/app.ts", change_type: "modified", patch: "@@ -1 +1 @@\n-old\n+new", is_binary: false, additions: 1, deletions: 1 }
      ]
    })))
  await page.route(new RegExp(`/api/cloud/api/repos/${REPO}/landings\\?`), (route) =>
    route.fulfill(json({
      items: [{
        number: 42,
        state: "open",
        change_ids: ["mzxvbnmk", "qupxosqw"],
        stack_size: 2,
        target_bookmark: "main",
        conflict_status: "none"
      }]
    })))
  await page.route(new RegExp(`/api/cloud/api/repos/${REPO}/landings/42/reviews`), (route) => route.fulfill(json({ reviews: [] })))
  await page.route(new RegExp(`/api/cloud/api/repos/${REPO}/landings/42/comments`), (route) => route.fulfill(json({ comments: [] })))
  await page.route(new RegExp(`/api/cloud/api/repos/${REPO}/commits/a03f5f1111111111/statuses`), (route) =>
    route.fulfill(json({ statuses: [{ context: "build", status: "success", created_at: "2026-09-01T09:59:00Z" }] })))
  await page.route("**/api/cloud/api/orgs/smithersai/changesets", (route) => route.fulfill(json({ changesets: [] })))
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

test("T1: /change.view renders a landing request's change end to end", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await page.getByTestId("composer-input").fill("/change.view qupxosqw")
  await page.getByTestId("composer-send").click()

  const card = page.getByTestId("card-change-smithersai/smithers-qupxosqw")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("smithersai/smithers · qupxosqw · a03f5f11 · will")
  await expect(card).toContainText("Add the split flow")
  await expect(card).toContainText("smithersai/smithers +1 −1")
  await expect(card).toContainText("Landing #42 · position 2 of 2 · open → main")

  // The diff facet (the default) lists the file; the checks facet renders the newest answer per context.
  await expect(card).toContainText("src/app.ts")
  await card.getByRole("tab", { name: "Checks" }).click()
  await expect(card).toContainText("build")
  await expect(card).toContainText("success")

  // The History facet: the ADR's degraded wording, never an invented rev count.
  await card.getByRole("tab", { name: "History" }).click()
  await expect(card).toContainText("revision history isn't recorded yet (plue#450)")
  await expect(card).not.toContainText("rev 1 of")
})

test("T1: /change.diff renders the parent → current pair pinned at the change's commit", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await page.getByTestId("composer-input").fill("/change.diff qupxosqw")
  await page.getByTestId("composer-send").click()

  const card = page.getByTestId("card-diff-smithersai/smithers-qupxosqw")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("smithersai/smithers · qupxosqw · parent → current")
  await expect(card).toContainText("pinned at a03f5f11")
  await expect(card).toContainText("src/app.ts")
  await expect(card).toContainText("@@ -1 +1 @@")
})

test("T1: a rev-pinned view refuses — the revision history doesn't exist (plue#450)", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await page.getByTestId("composer-input").fill("/change.view qupxosqw 2")
  await page.getByTestId("composer-send").click()

  const toast = page.locator(".toast-stack .toast-detail")
  await expect(toast).toContainText("revision history isn't recorded yet (plue#450)", { timeout: 15_000 })
})

test("T1: a degraded sign-in reads a change freely but can't dispatch an agent", async ({ page }) => {
  await serve(page, { degraded: true })
  await page.goto("/")

  await page.getByTestId("composer-input").fill("/change.view qupxosqw")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-change-smithersai/smithers-qupxosqw")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("qupxosqw")

  await page.getByTestId("composer-input").fill("/change.resolve qupxosqw src/app.ts")
  await page.getByTestId("composer-send").click()
  const toast = page.locator(".toast-stack .toast-detail")
  await expect(toast).toContainText("sign in again to enable", { timeout: 15_000 })
})

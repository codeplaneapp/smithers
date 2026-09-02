import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

/*
 * Lane sync T1 (docs/workbench-lanes/sync.md "Exit", ADR 0005): against a
 * fake cloud upstream the app connects a repository to a Linear team end to
 * end — the connector-setup card walks authorize → team → repository →
 * confirm and turns into the connected state on the SAME card — a sync
 * renders the sync-ops card with the plue#468 degraded note (never a faked
 * feed), sync.retry refuses with the ADR's wording, and a GitHub import
 * tracks its job to done with the workspace link.
 *
 * The server is a double (change.spec.ts's pattern): every seam answers
 * through page.route behind /api/cloud/*. The local origin runs offline in
 * T1, so the /api/linear-auth/* receiver (bun/LinearAuth.ts, covered by its
 * own bun tests) is doubled like every other route; window.open is stubbed
 * so the handoff URL is captured, never navigated.
 */

const REPO = "smithersai/smithers"

const INTEGRATION = {
  id: 7,
  linear_team_id: "team-eng",
  linear_team_key: "ENG",
  linear_team_name: "Engineering",
  repo_owner: "smithersai",
  repo_name: "smithers",
  is_active: true,
  last_sync_at: "2026-09-02T09:00:00Z",
  created_at: "2026-09-01T10:00:00Z"
}

const SETUP = {
  teams: [
    { id: "team-eng", name: "Engineering", key: "ENG" },
    { id: "team-design", name: "Design", key: "DES" }
  ],
  expires_at: "2099-09-02T12:00:00Z",
  viewer: { id: "u1", email: "will@example.com", name: "Will" }
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in to a cloud that inventories REPO, with the Linear seam's routes. */
const serve = async (page: Page): Promise<void> => {
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
    route.fulfill(json({ state: "signed-in", username: "will", expiresAt: "2027-01-01T00:00:00.000Z" })))
  await page.route("**/api/cloud/api/user/repos", (route) =>
    route.fulfill(json({ repos: [{ owner: "smithersai", name: "smithers", full_name: REPO, default_bookmark: "main" }] })))
  await page.route("**/api/cloud/api/user/orgs", (route) => route.fulfill(json({ orgs: [{ login: "smithersai" }] })))
  await page.route(/\/api\/cloud\/api\/user\/workspaces(\?.*)?$/, (route) => route.fulfill(json([])))
  await page.route(`**/api/cloud/api/repos/${REPO}/bookmarks`, (route) =>
    route.fulfill(json({
      items: [{ name: "main", target_change_id: "kxyzqrpv", target_commit_id: "c0ffee123456", is_tracking_remote: false }],
      next_cursor: ""
    })))

  /* The Linear seam: the integrations list grows when the create lands. */
  let integrations: Array<unknown> = []
  await page.route("**/api/cloud/api/linear", (route) => {
    if (route.request().method() === "POST") {
      integrations = [INTEGRATION]
      return route.fulfill(json(INTEGRATION, 201))
    }
    return route.fulfill(json(integrations))
  })
  /* The handoff receiver (doubled — the local origin is offline in T1). */
  let polls = 0
  await page.route("**/api/linear-auth/start", (route) =>
    route.fulfill(json({ url: "https://cloud.test/api/auth/linear?callback_port=9" })))
  await page.route("**/api/linear-auth/session", (route) => {
    polls += 1
    return route.fulfill(json(polls < 2 ? { state: "waiting" } : { state: "authorized", setupKey: "sk-123" }))
  })
  await page.route("**/api/cloud/api/linear/setup/sk-123", (route) => route.fulfill(json(SETUP)))
  await page.route("**/api/cloud/api/linear/7/sync", (route) => route.fulfill(json({ status: "sync_started" }, 202)))

  /* The import seam: the job starts cloning, then answers ready with its workspace. */
  let importPolls = 0
  await page.route("**/api/cloud/api/github/import", (route) =>
    route.fulfill(json({ importJobId: "job-1", status: "cloning", stage: "resolving", target_bookmark: "main" }, 202)))
  await page.route("**/api/cloud/api/github/import/job-1", (route) => {
    importPolls += 1
    return route.fulfill(json(importPolls < 2
      ? { importJobId: "job-1", status: "cloning", stage: "pushing_mirror", target_bookmark: "main" }
      : {
          importJobId: "job-1",
          status: "ready",
          stage: "provisioning_workspace",
          target_bookmark: "main",
          repository: { owner: "smithersai", name: "smithers" },
          workspace_id: "ws-9"
        }))
  })
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
    /* The handoff opens the system browser; in T1 the URL is captured, never navigated. */
    const opened: Array<string> = []
    Object.assign(window, { __openedUrls: opened })
    window.open = (url?: string | URL) => {
      opened.push(String(url ?? ""))
      return null
    }
  })
})

const runSlash = async (page: Page, command: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(command)
  await page.getByTestId("composer-send").click()
}

test("T1: /linear.connect walks the wizard and turns the card connected", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await runSlash(page, "/linear.connect")
  const card = page.getByTestId("card-connector-setup-linear-smithersai/smithers")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("Authorize in your browser")

  /* Step 1: the handoff — the URL went to the browser, the setup key came back. */
  await card.getByRole("button", { name: /Open Linear/ }).click()
  await expect(card).toContainText("authorized as Will", { timeout: 15_000 })
  const opened = await page.evaluate(() => (window as unknown as { __openedUrls: Array<string> }).__openedUrls)
  expect(opened).toEqual(["https://cloud.test/api/auth/linear?callback_port=9"])

  /* Step 2: the teams the key can see, one click each. */
  await card.getByRole("button", { name: /ENG · Engineering/ }).click()
  await expect(card).toContainText("ENG · Engineering")

  /* Step 4: the repository step defaults to the active repository — Connect. */
  await card.getByRole("button", { name: "Connect", exact: true }).click()

  /* The SAME card turns into the connected state. */
  await expect(card).toContainText("ENG · Engineering → smithersai/smithers", { timeout: 15_000 })
  await expect(card.getByRole("button", { name: /Sync now/ })).toBeVisible()
  await expect(card.getByRole("button", { name: /Disconnect/ })).toBeVisible()
})

test("T1: /linear.sync renders the sync-ops card with the degraded note; sync.retry refuses honestly", async ({ page }) => {
  await serve(page)
  /* The integration already exists in this cut. */
  await page.route("**/api/cloud/api/linear", (route) => {
    if (route.request().method() === "POST") return route.fulfill(json(INTEGRATION, 201))
    return route.fulfill(json([INTEGRATION]))
  })
  await page.goto("/")

  await runSlash(page, "/linear.sync")
  const syncCard = page.getByTestId("card-sync-ops-linear-7")
  await expect(syncCard).toBeVisible({ timeout: 15_000 })
  await expect(syncCard).toContainText("Linear ENG ↔ smithersai/smithers")
  await expect(syncCard).toContainText("sync started")
  await expect(syncCard).toContainText("plue#468")

  await runSlash(page, "/sync.retry op-3")
  await expect(page.getByText(/Retrying one sync op doesn't exist yet \(plue#468\)/)).toBeVisible({ timeout: 15_000 })
})

test("T1: /repos.import tracks the job to done with the workspace link", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await runSlash(page, `/repos.import ${REPO}`)
  const card = page.getByTestId("card-repo-import-smithersai/smithers")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("Contacting GitHub…")

  await expect(card).toContainText("done", { timeout: 20_000 })
  await expect(card).toContainText("smithersai/smithers")
  await expect(card.getByRole("button", { name: /Open the workspace/ })).toBeVisible()
})

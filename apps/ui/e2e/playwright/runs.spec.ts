import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

/*
 * Lane runs T1 (docs/workbench-lanes/runs.md "Exit"): launch a fixture flow,
 * steer it, stop it, and see it in the run inbox — the whole lifecycle over
 * the workspace gateway, with the server as a double (piper.spec.ts's
 * pattern): every seam answers through page.route, and the RPC double
 * records each procedure so the test asserts the wire, not just the pixels.
 */

const REPO = "smithersai/smithers"
const RUN_ID = "run-e2e"

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

interface RpcCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: Record<string, unknown>
}

const summaryRow = (status: string) => ({
  runId: RUN_ID,
  flowId: "review-pr",
  status,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: 1,
  calls: 2,
  callsFailed: 0,
  editsAttempted: 0,
  editsSucceeded: 0,
  inputTokens: 0,
  outputTokens: 0,
  verdict: status === "completed" ? "completed — done." : status,
  diagnosis: "Verdict   done."
})

/** Install the server double: signed in and allowlisted, one loaded repo, one gateway that accepts everything. */
const serve = async (page: Page): Promise<{ rpc: Array<RpcCall> }> => {
  const rpc: Array<RpcCall> = []
  let planned: { flowId: string; input: unknown } | undefined
  /** The engine's own accounting: a steer the gateway took is pending until the next turn. */
  let steeringPending = 0
  // The last route registered wins, so the catch-all goes first.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404)))
  await page.route("**/api/bootstrap", (route) => route.fulfill(json({
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "test",
    capabilities: ["agent", "identity", "cloud", "local.repositories"],
    authFlow: "none",
    sandbox: { platform: "darwin", mode: "trusted-only" }
  })))
  await page.route("**/api/repos", (route) => route.fulfill(json({ repos: [] })))
  await page.route("**/api/auth/session", (route) =>
    route.fulfill(json({ login: "will", allowlisted: true, admin: false })))
  await page.route("**/api/cloud-auth/session", (route) =>
    route.fulfill(json({ state: "signed-in", username: "will", expiresAt: "2027-01-01T00:00:00.000Z" })))
  await page.route("**/api/cloud/api/user/repos", (route) =>
    route.fulfill(json({
      repos: [{ owner: "smithersai", name: "smithers", full_name: REPO, default_bookmark: "main" }]
    })))
  await page.route("**/api/cloud/api/user/orgs", (route) => route.fulfill(json({ orgs: [{ login: "smithersai" }] })))
  await page.route("**/api/cloud/api/repos/smithersai/smithers/bookmarks", (route) =>
    route.fulfill(json({ bookmarks: [{ name: "main", target_change_id: "kxyzqrpv", target_commit_id: "c0ffee" }] })))
  await page.route("**/api/cloud/api/user/workspaces", (route) => route.fulfill(json({ workspaces: [] })))
  await page.route("**/api/workflow/provision", (route) =>
    route.fulfill(json({ status: "ready", repo: REPO, gatewayId: "gw-1" })))
  await page.route("**/api/workflow/rpc", async (route) => {
    const call = route.request().postDataJSON() as RpcCall
    rpc.push(call)
    const rows = (projection: string, value: ReadonlyArray<unknown>) =>
      route.fulfill(json({ ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: value } }))
    switch (call.procedure) {
      case "List":
        return route.fulfill(json({
          ok: true,
          payload: { _tag: "flows", items: [{ flowId: "review-pr", description: "Review a PR" }] }
        }))
      case "Plan":
        planned = { flowId: String(call.payload.flowId), input: call.payload.input }
        return route.fulfill(json({
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: planned.flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        }))
      case "Run":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: RUN_ID } }))
      case "Approval.Submit":
        // The launch path auto-approves the plan it just made.
        return route.fulfill(json({ ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } }))
      case "Steer":
        steeringPending += 1
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Resume":
      case "Signal":
      case "Cancel":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Projection.Snapshot": {
        const selector = (call.payload.selector ?? {}) as { _tag?: string }
        switch (selector._tag) {
          case "workspace-runs":
            return rows("workspace-runs", [{ ...summaryRow("running"), steeringPending }])
          case "run-summary":
            return rows("run-summary", [{ ...summaryRow("running"), steeringPending }])
          case "approvals":
            return rows("approvals", [])
          case "transcript":
            return rows("transcript", [])
          default:
            return rows(String(selector._tag), [])
        }
      }
      default:
        return route.fulfill(json({ ok: false, error: { message: `no ${call.procedure}` } }))
    }
  })
  return { rpc }
}

const send = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-send").click()
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

test("T1: launch a fixture flow, steer it, stop it, and see it in the run inbox", async ({ page }) => {
  const { rpc } = await serve(page)
  await page.goto("/")

  // Launch: /flow.run provisions the workspace, plans, and runs — the card tracks the run.
  await send(page, "/flow.run review-pr")
  const runCardId = `flow-run-${RUN_ID}`
  const card = page.getByTestId(`card-${runCardId}`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("Running on your workspace.")
  expect(rpc.map((call) => call.procedure)).toContain("Run")

  // Steer: the row's message rides the Steer procedure with the steer envelope.
  await card.getByTestId(`flow-run-steer-input-${RUN_ID}`).fill("use the smaller diff")
  await card.getByRole("button", { name: "Steer" }).click()
  await expect.poll(() => rpc.some((call) => call.procedure === "Steer")).toBe(true)
  const steer = rpc.find((call) => call.procedure === "Steer")!
  expect(steer.payload.runId).toBe(RUN_ID)
  expect(steer.payload.message).toMatchObject({ kind: "Message", body: "use the smaller diff", runId: RUN_ID })
  await expect(card).toContainText("steering pending")

  // The run inbox: /runs.list renders the workspace's runs, this one among them.
  await send(page, "/runs.list")
  const runListCardId = `run-list-${REPO}`
  const inbox = page.getByTestId(`card-${runListCardId}`)
  await expect(inbox).toBeVisible()
  await expect(inbox).toContainText(RUN_ID)
  await expect(inbox).toContainText("review-pr")
  expect(rpc.some((call) =>
    call.procedure === "Projection.Snapshot" &&
    JSON.stringify(call.payload).includes("workspace-runs")
  )).toBe(true)

  // Stop: the card's own act cancels the run, and the card says so.
  await card.getByTestId(`flow-run-stop-${RUN_ID}`).click()
  await expect.poll(() => rpc.some((call) => call.procedure === "Cancel")).toBe(true)
  const cancel = rpc.find((call) => call.procedure === "Cancel")!
  expect(cancel.payload.runId).toBe(RUN_ID)
  await expect(card).toContainText("Cancelled.")
})

import { expect, test } from "@playwright/test"
import type { Locator, Page } from "@playwright/test"
import { CODING_PLAN } from "../../src/mainview/cards/fixtures/CodingPlan"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane runs T1 (docs/workbench-lanes/runs.md "Exit"): launch a fixture flow,
 * steer it, stop it, and see it in the run inbox — the whole lifecycle over
 * the workspace gateway, with the server as a double: the shared cloud
 * fixture (cloudFixture.ts) answers the bootstrap, the sessions and the
 * Smithers Cloud inventory, this spec adds the gateway, and the RPC double
 * records each procedure so the test asserts the wire, not just the pixels.
 */

const REPO = "smithersai/smithers"
const RUN_ID = "run-e2e"

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

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in as the scoped-down user, one loaded repo, one gateway that accepts everything. */
const serve = async (page: Page, journal: ReadonlyArray<Record<string, unknown>> = []): Promise<{ rpc: Array<RpcCall> }> => {
  const rpc: Array<RpcCall> = []
  let planned: { flowId: string; input: unknown } | undefined
  /** The engine's own accounting: a steer the gateway took is pending until the next turn. */
  let steeringPending = 0
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "local.repositories"] })
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
          case "run-events":
            return rows("run-events", journal)
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
  await expect(page.locator(".guide-shell")).toBeVisible()
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
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
  await send(page, `/flow.run review-pr ${REPO}`)
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
  await send(page, `/runs.list ${REPO}`)
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

test("T1: turn explanations lead to durable historical inspection in the same embedded frame", async ({ page }) => {
  const record = (sequence: number, kind: string, payload: Record<string, unknown>) => ({ sequence, kind, occurredAt: 1000 + sequence, payload })
  const journal = [
    record(1, "control.agent.turn-opened", { seat: "test-model" }),
    record(2, "control.agent.model-settled", { text: "I’ll read the existing implementation before changing it." }),
    record(3, "control.agent.cell-produced", { language: "ts", text: "await ctx.call('files.read', { path: 'src/index.ts' })" }),
    record(4, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "src/index.ts" } })
  ]
  await serve(page, journal)
  await page.goto("/")
  await send(page, `/runs.open run-e2e ${REPO}`)
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  await expect(card.getByRole("list", { name: "Turn explanations" })).toContainText("I’ll read the existing implementation")
  await expect(card.getByRole("list", { name: "Call tree" })).toHaveCount(0)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await send(page, "/debug.verbose")
  await expect(page.getByText("Verbose on — showing every flow, including hidden and background ones", { exact: true })).toBeVisible()

  await card.locator("[data-turn='1']").click()
  await card.locator("[data-trace-span='call-1']").click()
  const pane = card.getByTestId(`run-trace-pane-${RUN_ID}`)
  await expect(pane).toHaveAttribute("data-span", "call-1")
  await expect(pane).toContainText("src/index.ts")
  // Rendering is optimistic; wait for the existing command-settlement trace before reloading OPFS.
  await expect(page.getByText(/You ran \/runs\.trace\.select run-e2e call-1 .*→ executed/)).toBeVisible()
  await expect(card).toContainText("At #4")
  journal.push(record(5, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "later recorded content" }))

  // Reload keeps the selected historical input and does not show a later value.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Talk to Smithers" })).toBeHidden()
  await page.reload()
  await expect(page.locator(".guide-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  await expect(pane).toHaveAttribute("data-span", "call-1")
  await expect(pane).not.toContainText("later recorded content")
  await expect(card).toContainText("At #4")
  const path = card.getByRole("navigation", { name: "Recorded call path" })
  await expect(path).toContainText("frame 1")
  await expect(path).toContainText("cell · ts")

  await card.evaluate((element) => element.setAttribute("data-node-proof", "preserved"))
  await card.getByTestId(`card-maximize-flow-run-${RUN_ID}`).click()
  await expect(card).toHaveAttribute("data-node-proof", "preserved")
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await card.getByTestId(`card-minimize-flow-run-${RUN_ID}`).click()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await card.getByRole("button", { name: "Latest", exact: true }).click()
  await expect(card.getByRole("list", { name: "Call tree" })).toHaveCount(0)
  await card.locator("[data-turn='1']").click()
  await card.locator("[data-trace-span='call-1']").click()
  await expect(pane).toContainText("later recorded content")
  await expect(card).toContainText("At #5")
})


/** Reach a native control through the keyboard order; never move focus with a pointer or DOM mutation. */
const tabTo = async (page: Page, target: Locator): Promise<void> => {
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  throw new Error("The coding control was not reachable with Tab")
}

test("T1: coding plan launch, inspection and restoration work with only the keyboard in the Command-K shell", async ({ page }) => {
  test.setTimeout(120_000)
  const { rpc } = await serve(page)
  await page.goto("/")
  await expect(page.locator(".guide-shell")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ plan: CODING_PLAN })}`)
  await page.keyboard.press("Enter")
  const card = page.getByTestId(`card-flow-run-${RUN_ID}`)
  await expect(card.getByRole("list", { name: "Predicted Changes", exact: true })).toContainText("Store repository memory")
  expect(rpc.find((call) => call.procedure === "Plan")?.payload).toMatchObject({ flowId: "coding", input: { plan: CODING_PLAN } })
  const first = card.getByRole("button", { name: /Store repository memory/ })
  await tabTo(page, page.getByTestId("composer-input"))
  await page.keyboard.insertText("/debug.verbose")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Verbose on — showing every flow, including hidden and background ones", { exact: true })).toBeVisible()
  await tabTo(page, first)
  expect(await first.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  await expect(first).toHaveAttribute("aria-expanded", "true")
  await expect(card.getByRole("list", { name: "Predicted atomic changes" })).toContainText("persist causal documents")
  await expect(card).toContainText("src/memory.test.ts")
  await expect(card).toContainText("fast · required")
  await expect(card).not.toContainText("passed")
  await expect(page.getByText(/You ran \/runs\.coding\.select run-e2e memory .*→ executed/)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Talk to Smithers" })).toBeHidden()
  await page.reload()
  await expect(page.locator(".guide-shell")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("Control+k")
  await expect(first).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.insertText("/debug.verbose")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Verbose off", { exact: true })).toBeVisible()
  await tabTo(page, first)
  await page.keyboard.press("Space")
  await expect(first).toHaveAttribute("aria-expanded", "false")
  const second = card.getByRole("button", { name: /Connect the Wiki interface/ })
  await page.keyboard.press("Tab")
  await expect(second).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(card.getByRole("list", { name: "Predicted atomic changes" })).toContainText("render repository memory")
  await page.screenshot({ path: "/tmp/smithers-coding-plan-ui.png", fullPage: true })
  await tabTo(page, card.getByTestId(`card-maximize-flow-run-${RUN_ID}`))
  const node = await card.getByRole("region", { name: "Coding plan" }).elementHandle()
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  expect(await card.getByRole("region", { name: "Coding plan" }).evaluate((element, original) => element === original, node)).toBe(true)
  expect(rpc.some((call) => call.procedure === "Run")).toBe(true)
})

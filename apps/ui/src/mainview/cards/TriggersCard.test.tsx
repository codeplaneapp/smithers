import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { describeSchedule } from "./TriggerEvents"
import { TriggerListCardBody } from "./TriggersCard"

/*
 * The dispatchers card: every row says the event in words, the flow it
 * runs, and its state; an empty list says the seam's reason; and a schedule
 * the shorthand cannot say falls back to the expression, never to a guess.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"

const triggerCard = (
  triggers: Extract<Card, { kind: "trigger-list" }>["payload"]["triggers"],
  reason?: string
): Extract<Card, { kind: "trigger-list" }> => ({
  id: `trigger-list-${REPO}`,
  kind: "trigger-list",
  title: `Triggers — ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, ...(reason === undefined ? {} : { reason }), triggers }
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(element)
  })
  return host
}

describe("the event a trigger waits for, in words", () => {
  test("names the common schedules and prints the zone only when the trigger declared one", () => {
    expect(describeSchedule("0 9 * * 1-5", "UTC")).toBe("Every weekday at 09:00 UTC")
    expect(describeSchedule("30 17 * * *")).toBe("Every day at 17:30")
    expect(describeSchedule("0 8 * * 1,3,5", "Europe/London")).toBe("Every Monday, Wednesday, Friday at 08:00 Europe/London")
    expect(describeSchedule("0 0 * * 0")).toBe("Every Sunday at 00:00")
    expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes")
    expect(describeSchedule("0 * * * *")).toBe("Every hour")
    expect(describeSchedule("0 */6 * * *")).toBe("Every 6 hours")
    expect(describeSchedule("* * * * *")).toBe("Every minute")
    expect(describeSchedule("0 6 1 * *", "UTC")).toBe("Monthly on day 1 at 06:00 UTC")
  })

  test("a schedule the shorthand cannot say is shown as its expression", () => {
    expect(describeSchedule("0 9 * 1-6 1-5")).toBe("On the schedule 0 9 * 1-6 1-5")
    expect(describeSchedule("5 4 * * sun", "UTC")).toBe("On the schedule 5 4 * * sun UTC")
    expect(describeSchedule("not a cron")).toBe("On the schedule not a cron")
  })
})

describe("the dispatchers card", () => {
  test("each row states the event, the flow it runs, and its state", () => {
    const host = render(
      <TriggerListCardBody
        card={triggerCard([
          { id: "nightly", flowId: "review-pr", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true, lastFiredAt: Date.now() - 60_000 },
          { id: "sweep", flowId: "issue-sweep", cron: "*/15 * * * *", enabled: false }
        ])}
      />
    )
    const rows = [...host.querySelectorAll("[data-trigger]")]
    expect(rows.map((row) => row.getAttribute("data-trigger"))).toEqual(["nightly", "sweep"])
    expect(rows[0]?.textContent).toContain("Every weekday at 09:00 UTC")
    expect(rows[0]?.textContent).toContain("runs review-pr")
    expect(host.querySelector("[data-testid='trigger-state-nightly']")?.textContent).toMatch(/^enabled · last fired /)
    expect(rows[1]?.textContent).toContain("Every 15 minutes")
    expect(rows[1]?.textContent).toContain("runs issue-sweep")
    expect(host.querySelector("[data-testid='trigger-state-sweep']")?.textContent).toBe("disabled · never fired")
    expect(host.querySelector("button")).toBeNull()
  })

  test("an empty list shows the seam's reason, or the plain fact when there is none", () => {
    const reason = "Your Smithers Cloud workspace does not serve its trigger store yet."
    const withReason = render(<TriggerListCardBody card={triggerCard([], reason)} />)
    expect(withReason.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe(reason)
    expect(withReason.querySelector("[data-trigger]")).toBeNull()
    const bare = render(<TriggerListCardBody card={triggerCard([])} />)
    expect(bare.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe("No triggers on this repository yet.")
  })
})

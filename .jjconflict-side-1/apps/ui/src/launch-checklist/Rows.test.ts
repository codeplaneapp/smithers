/*
 * The row catalog: every checklist row is actually checked, and the probes
 * that decide the hard rows decide them for the stated reason.
 *
 * The panel finding this answers: "those rows have no probes, and D-4 does not
 * assert that workflow launch pauses". Both are asserted here against a fake
 * page, so a regression that quietly drops a probe fails the gate.
 */
import { describe, expect, test } from "bun:test"
import { ROWS } from "./Rows.ts"
import { runChecklist } from "./Runner.ts"
import { BrowserUnavailableError, type ChecklistRow, type ProbeContext, type ProbePage } from "./Types.ts"

interface FakePageOptions {
  /** Successive `document.body.innerText` values; the last one repeats. */
  readonly texts: ReadonlyArray<string>
  readonly evaluate: (expression: string) => unknown
}

interface Recorder {
  readonly typed: Array<string>
  readonly pressed: Array<string>
  reloads: number
}

const fakePage = (options: FakePageOptions, recorder: Recorder): ProbePage => {
  let index = 0
  return {
    text: async () => {
      const value = options.texts[Math.min(index, options.texts.length - 1)] ?? ""
      index += 1
      return value
    },
    evaluate: async <T>(expression: string) => options.evaluate(expression) as T,
    type: async (value: string) => {
      recorder.typed.push(value)
    },
    press: async (key: string) => {
      recorder.pressed.push(key)
    },
    reload: async () => {
      recorder.reloads += 1
    }
  }
}

const contextFor = (
  options: {
    readonly page?: ProbePage
    readonly env?: Record<string, string | undefined>
    readonly fetch?: ProbeContext["fetch"]
  } = {}
): ProbeContext => {
  // A clock that jumps a full second per read so budgeted waits end fast.
  let clock = 0
  return {
    target: "https://example.test",
    env: options.env ?? {},
    page: async () => options.page ?? Promise.reject(new BrowserUnavailableError("no browser configured in this test")),
    fetch: options.fetch ?? (() => Promise.reject(new Error("no fetch configured"))),
    now: () => (clock += 1_000),
    sleep: () => Promise.resolve()
  }
}

const rowById = (id: string): ChecklistRow => {
  const found = ROWS.find((row) => row.id === id)
  if (found === undefined) throw new Error(`no row ${id}`)
  return found
}

const recorder = (): Recorder => ({ typed: [], pressed: [], reloads: 0 })

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status })

describe("the row catalog", () => {
  test("covers every checklist section", () => {
    expect([...new Set(ROWS.map((row) => row.section))].sort()).toEqual(["A", "B", "C", "D", "E", "F"])
  })

  test("every row carries a probe — nothing is enumerated but unchecked", () => {
    const unprobed = ROWS.filter((row) => typeof row.probe !== "function").map((row) => row.id)
    expect(unprobed).toEqual([])
  })

  test("row ids are unique", () => {
    expect(new Set(ROWS.map((row) => row.id)).size).toBe(ROWS.length)
  })

  test("the signed-in rows drive a headless page, so the checklist runs headlessly rather than by hand", () => {
    const browserRows = ROWS.filter((row) => row.browser === true).map((row) => row.id)
    for (const id of ["A-1", "B-2", "C-1", "C-2", "D-4", "F-1", "F-6"]) {
      expect(browserRows).toContain(id)
    }
  })

  test("the browser rows say which session they need instead of failing on absent auth", async () => {
    const results = await runChecklist({ rows: ROWS, mode: "run", context: contextFor() })
    const sessionRows = results.filter((row) => row.status === "not-testable-yet")
    expect(sessionRows.length).toBeGreaterThan(0)
    expect(results.filter((row) => row.status === "fail")).toEqual([])
  })
})

describe("A-1 (signed-out chat, no separate landing view)", () => {
  const evaluate = (expression: string): unknown => {
    if (expression.includes("textarea") && expression.includes("!== null")) return true
    if (expression.includes("tabindex")) return ["auth.sign-in", "textarea"]
    return null
  }

  test("passes when the composer, the opening message, and a first-Tab sign-in are all there", async () => {
    const page = fakePage({ texts: ["x".repeat(200)], evaluate }, recorder())
    const result = await rowById("A-1").probe(contextFor({ page }))
    expect(result.status).toBe("pass")
  })

  test("fails when sign-in is not the first tab stop", async () => {
    const page = fakePage(
      {
        texts: ["x".repeat(200)],
        evaluate: (e) => (e.includes("tabindex") ? ["textarea", "auth.sign-in"] : evaluate(e))
      },
      recorder()
    )
    const result = await rowById("A-1").probe(contextFor({ page }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("auth.sign-in at index 1")
  })
})

describe("A-5 (the $500 grant line is stated exactly once)", () => {
  const evaluateWith = (introUsd: string | null) => (expression: string): unknown =>
    expression.includes("/api/billing/balance")
      ? { status: 200, body: { introUsd }, text: "" }
      : null

  test("passes with one statement while the grant is unspent", async () => {
    const page = fakePage({ texts: ["You have $500 of usage on us."], evaluate: evaluateWith("500.00") }, recorder())
    expect((await rowById("A-5").probe(contextFor({ page }))).status).toBe("pass")
  })

  test("fails when the line is repeated", async () => {
    const page = fakePage(
      { texts: ["$500 of usage on us ... and again $500 of usage on us"], evaluate: evaluateWith("500.00") },
      recorder()
    )
    const result = await rowById("A-5").probe(contextFor({ page }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("2x")
  })

  test("fails when the line survives a spent grant", async () => {
    const page = fakePage({ texts: ["$500 of usage on us"], evaluate: evaluateWith(null) }, recorder())
    expect((await rowById("A-5").probe(contextFor({ page }))).status).toBe("fail")
  })
})

describe("C-1 (every affordance resolves to a /name)", () => {
  const evaluate = (affordances: unknown, commands: ReadonlyArray<string>) => (expression: string): unknown => {
    if (expression.includes("data-flows")) return commands
    if (expression.includes("role=button")) return affordances
    return null
  }

  test("passes when every visible affordance carries a registered command name", async () => {
    const page = fakePage(
      {
        texts: ["x".repeat(200)],
        evaluate: evaluate([{ label: "Accept", flow: "flow.run" }], ["flow.run", "flow.list"])
      },
      recorder()
    )
    expect((await rowById("C-1").probe(contextFor({ page }))).status).toBe("pass")
  })

  test("fails and names the affordance that has no command", async () => {
    const page = fakePage(
      {
        texts: ["x".repeat(200)],
        evaluate: evaluate(
          [
            { label: "Accept", flow: "flow.run" },
            { label: "Mystery", flow: null }
          ],
          ["flow.run"]
        )
      },
      recorder()
    )
    const result = await rowById("C-1").probe(contextFor({ page }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("Mystery → no data-flow")
  })
})

describe("D-4 (at $0, chat keeps working and non-complimentary work pauses)", () => {
  const turnOk: ProbeContext["fetch"] = async () => jsonResponse("{\"type\":\"done\"}")
  const evaluate = (expression: string): unknown => (expression.includes("textarea") ? true : null)
  const env = { CHECKLIST_ZERO_BALANCE_BEARER: "smithers_session=zero" }

  test("passes only when the workflow launch is refused with the pause statement", async () => {
    const track = recorder()
    const page = fakePage(
      {
        texts: [
          "transcript",
          "transcript\nBalance is at $0 — workflow runs pause until more balance is added."
        ],
        evaluate
      },
      track
    )
    const result = await rowById("D-4").probe(contextFor({ page, env, fetch: turnOk }))
    expect(result.status).toBe("pass")
    expect(track.typed.join(" ")).toContain("/flow.create")
    expect(result.detail).toContain("pause statement=true")
  })

  test("fails when a workflow launch at $0 does not pause", async () => {
    const page = fakePage({ texts: ["transcript", "transcript\nRun started."], evaluate }, recorder())
    const result = await rowById("D-4").probe(contextFor({ page, env, fetch: turnOk }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("pause statement=false")
  })

  test("fails when interactive chat itself stops working at $0", async () => {
    const page = fakePage(
      { texts: ["transcript", "transcript\nworkflow runs pause until more balance is added."], evaluate },
      recorder()
    )
    const result = await rowById("D-4").probe(
      contextFor({ page, env, fetch: async () => jsonResponse("nope", 402) })
    )
    expect(result.status).toBe("fail")
  })
})

describe("F-1 (an impossible ask refuses honestly)", () => {
  const evaluate = (expression: string): unknown => (expression.includes("textarea") ? true : null)
  const env = { CHECKLIST_SESSION_COOKIE: "smithers_session=abc" }

  test("passes on a can't-yet answer", async () => {
    const page = fakePage(
      { texts: ["transcript", "transcript\nI can't yet send email — connect a mail tool and I will."], evaluate },
      recorder()
    )
    expect((await rowById("F-1").probe(contextFor({ page, env }))).status).toBe("pass")
  })

  test("fails on a faked success", async () => {
    const page = fakePage(
      { texts: ["transcript", "transcript\nDone — I have sent the email to will@tevm.tech as requested."], evaluate },
      recorder()
    )
    const result = await rowById("F-1").probe(contextFor({ page, env }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("fake-success=true")
  })
})

describe("E-1 (the billing admin surface rejects an unauthenticated grant)", () => {
  test("passes on a 401 and fails on anything else", async () => {
    const env = { CHECKLIST_BILLING_UPSTREAM_URL: "https://billing.test" }
    const denied = await rowById("E-1").probe(
      contextFor({ env, fetch: async () => jsonResponse("unauthorized", 401) })
    )
    expect(denied.status).toBe("pass")
    const allowed = await rowById("E-1").probe(contextFor({ env, fetch: async () => jsonResponse({ id: "g1" }, 201) }))
    expect(allowed.status).toBe("fail")
  })
})

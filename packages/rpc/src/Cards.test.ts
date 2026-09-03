import { describe, expect, test } from "bun:test"
import { CardSchema } from "./Cards"
import { LSP_DIAGNOSTICS_CAP } from "./LocalApp"

const base = { id: "card-r1", title: "Aomi", status: "active", createdAt: 0, ordinal: 0 }

/*
 * Lane citc (ADR 0002): the workspace card carries the plue DTO trimmed to
 * what the card states — no kind, no uptime, no workspace head, no
 * ahead/behind (plue#446) — and the service-log contract lands with it.
 */
describe("the workspace card", () => {
  const payload = {
    workspaceId: "ws-1",
    repo: "will/smithers",
    name: "review",
    targetBookmark: "main",
    status: "running",
    provisioningStage: null,
    bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
    snapshots: [{ id: "snap-1", name: "before-upgrade", createdAt: "2026-09-01T10:00:00Z" }],
    sessions: [{ id: "sess-1", status: "running", createdAt: null }]
  }

  test("carries the DTO plus the bookmark head, and defaults nothing", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload })
    if (card.kind !== "workspace") return
    expect(card.payload.status).toBe("running")
    expect(card.payload.bookmarkHead).toEqual({ changeId: "qupxosqw", commitId: "c0ffee1" })
    // The forbidden fields are not in the schema at all (plue#446).
    expect(JSON.stringify(Object.keys(card.payload))).not.toMatch(/kind|uptime|ahead|behind/)
  })

  test("a status outside plue's six is rejected", () => {
    expect(CardSchema.safeParse({ ...base, kind: "workspace", payload: { ...payload, status: "melting" } }).success)
      .toBe(false)
  })

  test("the bookmark head may be absent (an unread head is not a fact)", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload: { ...payload, bookmarkHead: null } })
    if (card.kind !== "workspace") return
    expect(card.payload.bookmarkHead).toBeNull()
  })
})

describe("the service-log card", () => {
  test("carries the service, its lines, and the follow state", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "service-log",
      payload: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
    })
    if (card.kind !== "service-log") return
    expect(card.payload.follow).toBe(true)
    expect(card.payload.lines).toEqual(["listening"])
  })
})

/*
 * Code intelligence (apps/ui/docs/code-intel/PLAN.md §5): the file card's
 * anchor, what the language server published, the hover answer, and the
 * server state live in the payload, all optional so a card persisted before
 * the lane parses unchanged and states none of them.
 */
describe("the file card", () => {
  const payload = { repo: "smithers", path: "apps/ui/src/mainview/App.tsx", content: "export {}\n", truncated: false }
  const diagnostic = {
    line: 317,
    character: 62,
    endLine: 317,
    endCharacter: 68,
    severity: "error" as const,
    message: "Property 'lenght' does not exist on type 'string'.",
    source: "ts",
    code: "2551"
  }
  const parses = (extra: Record<string, unknown>): boolean =>
    CardSchema.safeParse({ ...base, kind: "file", payload: { ...payload, ...extra } }).success

  test("a card persisted before code intelligence parses and states no anchor, diagnostics, hover, or server", () => {
    const card = CardSchema.parse({ ...base, kind: "file", payload })
    if (card.kind !== "file") return
    expect(card.payload.line).toBeUndefined()
    expect(card.payload.column).toBeUndefined()
    expect(card.payload.diagnostics).toBeUndefined()
    expect(card.payload.hover).toBeUndefined()
    expect(card.payload.intel).toBeUndefined()
  })

  test("carries the anchor, what the server published, the hover answer, and the server state", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "file",
      payload: {
        ...payload,
        line: 317,
        column: 62,
        diagnostics: [diagnostic],
        hover: { line: 63, character: 7, contents: "const isRecord: (value: unknown) => value is Record<string, unknown>" },
        intel: { state: "missing", note: "npm i -g typescript-language-server typescript" }
      }
    })
    if (card.kind !== "file") return
    expect(card.payload.line).toBe(317)
    expect(card.payload.column).toBe(62)
    expect(card.payload.diagnostics).toEqual([diagnostic])
    expect(card.payload.hover?.contents).toContain("value is Record")
    expect(card.payload.intel).toEqual({ state: "missing", note: "npm i -g typescript-language-server typescript" })
  })

  test("a hover the server had nothing for is null, which is not the same as never asked", () => {
    const card = CardSchema.parse({ ...base, kind: "file", payload: { ...payload, hover: null } })
    if (card.kind !== "file") return
    expect(card.payload.hover).toBeNull()
  })

  test("refuses a 0-based anchor, a severity outside the four, a state outside the four, and more diagnostics than the host cap", () => {
    expect(parses({ line: 0 })).toBe(false)
    expect(parses({ column: 0 })).toBe(false)
    expect(parses({ diagnostics: [{ ...diagnostic, severity: "fatal" }] })).toBe(false)
    expect(parses({ diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP }, () => diagnostic) })).toBe(true)
    expect(parses({ diagnostics: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic) })).toBe(false)
    expect(parses({ intel: { state: "installing" } })).toBe(false)
  })
})

/*
 * Custom agents (docs/workbench-lanes/custom-agents.md): the Agents card
 * carries every agent with the harness's live availability, the form card
 * carries its draft in the payload, and the subagent card accepts a custom
 * role id beside a built-in one.
 */
describe("the agent cards", () => {
  const row = {
    id: "reviewer",
    label: "Reviewer",
    purpose: "Reviews diffs.",
    harness: "codex",
    harnessName: "Codex",
    model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    builtin: false,
    available: true,
    reason: "",
    account: "will@example.com"
  }

  test("the agents card lists rows with availability; a bad id or a model with a space is refused", () => {
    const card = CardSchema.parse({ ...base, kind: "agents", payload: { native: true, agents: [row] } })
    if (card.kind !== "agents") return
    expect(card.payload.agents[0]?.available).toBe(true)
    expect(CardSchema.safeParse({ ...base, kind: "agents", payload: { native: true, agents: [{ ...row, id: "Bad Id" }] } }).success).toBe(false)
    expect(
      CardSchema.safeParse({ ...base, kind: "agents", payload: { native: true, agents: [{ ...row, model: { ...row.model, id: "gpt 5" } }] } })
        .success
    ).toBe(false)
  })

  test("the flow-form card holds the flow, who asked, the derived fields, the draft and what was given; a bad kind or provider is rejected", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "flow-form",
      payload: {
        flow: "agent.create",
        via: "agent",
        fields: [
          { name: "id", label: "Id", kind: "text", required: true },
          {
            name: "harness",
            label: "Harness",
            kind: "select",
            required: true,
            optionsFrom: "agent-harnesses",
            options: [
              { value: "codex", label: "Codex · OPENAI_API_KEY" },
              { value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" }
            ]
          },
          { name: "model", label: "Model", kind: "text", required: true, optionsFrom: "harness-models", options: [] },
          { name: "purpose", label: "Purpose", kind: "text", required: false }
        ],
        draft: { id: "reviewer", harness: "codex" },
        given: { id: "reviewer", harness: "codex" }
      }
    })
    if (card.kind !== "flow-form") return
    expect(card.payload.fields[1]?.options?.[1]).toEqual({ value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" })
    expect(card.payload.draft.harness).toBe("codex")
    const payload = card.payload
    expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, fields: [{ name: "x", label: "X", kind: "date", required: true }] } }).success).toBe(false)
    expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, fields: [{ name: "x", label: "X", kind: "select", required: true, optionsFrom: "moons" }] } }).success).toBe(false)
    expect(CardSchema.safeParse({ ...base, kind: "flow-form", payload: { ...payload, via: "system" } }).success).toBe(false)
    // The hand-made agent form is gone: the generic card is the only form.
    expect(CardSchema.safeParse({ ...base, kind: "agent-form", payload: { mode: "create", draft: {}, harnesses: [], models: [], phase: "editing" } }).success).toBe(false)
  })

  test("the models card is what the harness printed, with its source", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "agent-models",
      payload: { harnessId: "opencode", displayName: "OpenCode", models: ["cerebras/gpt-oss-120b"], source: "list" }
    })
    if (card.kind !== "agent-models") return
    expect(card.payload.models).toEqual(["cerebras/gpt-oss-120b"])
  })

  test("the subagent card takes a custom role id and its purpose, and still parses without one", () => {
    const payload = {
      harnessId: "codex",
      displayName: "Reviewer · GPT-5.6 Terra",
      roleId: "reviewer",
      purpose: "Reviews diffs.",
      tabId: "pty-1",
      sessionId: "pty-1",
      cwd: "/tmp",
      phase: "running",
      exitCode: null
    }
    const card = CardSchema.parse({ ...base, kind: "agent", payload })
    if (card.kind !== "agent") return
    expect(card.payload.roleId).toBe("reviewer")
    expect(card.payload.purpose).toBe("Reviews diffs.")
    const { roleId: _roleId, purpose: _purpose, ...bare } = payload
    expect(CardSchema.safeParse({ ...base, kind: "agent", payload: bare }).success).toBe(true)
    expect(CardSchema.safeParse({ ...base, kind: "agent", payload: { ...payload, roleId: "Not An Id" } }).success).toBe(false)
  })
})

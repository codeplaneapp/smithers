import { describe, expect, test } from "bun:test"
import { payloadFor } from "./SlashPayload"

/*
 * The composer boundary refuses what it cannot parse exactly. `files.list`
 * and `files.read` already reject extra tokens; `flow.run` and `admin.grant`
 * silently dropped every token after the second, so `/admin.grant 25 octocat
 * 1000` granted 25 with the typo invisible. Extra tokens are now refused.
 */

describe("slash payload argument counts", () => {
  test("flow.run refuses a third token instead of dropping it", () => {
    const parsed = payloadFor("flow.run", "create-workflow will/flows extra")
    expect(parsed).toEqual({ error: "flow.run takes a workflow name and optionally an owner/repo" })
  })

  test("flow.run still takes its name and optional repo", () => {
    expect(payloadFor("flow.run", "create-workflow")).toEqual({ payload: { name: "create-workflow" } })
    expect(payloadFor("flow.run", "create-workflow will/flows")).toEqual({
      payload: { name: "create-workflow", repo: "will/flows" }
    })
    expect(payloadFor("flow.run", "")).toEqual({
      error: "flow.run needs a workflow name: /flow.run create-workflow"
    })
  })

  test("admin.grant refuses a third token instead of dropping it", () => {
    const parsed = payloadFor("admin.grant", "25 octocat 1000")
    expect(parsed).toEqual({ error: "admin.grant takes an amount in dollars and a login" })
  })

  test("admin.grant still takes its amount and login", () => {
    expect(payloadFor("admin.grant", "25 octocat")).toEqual({ payload: { amountUsd: 25, login: "octocat" } })
    expect(payloadFor("admin.grant", "octocat")).toEqual({
      error: "admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat"
    })
  })

  test("the files.* boundary the others now match", () => {
    expect(payloadFor("files.list", "src will/flows extra")).toEqual({
      error: "files.list takes a path and optionally an owner/repo"
    })
  })
})

/*
 * The target reference (docs/LOCAL-APP.md "Cards"): `target.run` takes
 * `<repoId> [workspace] <label>`. A label is `//pkg:name` and never holds
 * whitespace, so the LAST token is the label and everything between it and
 * the repo id is the workspace path — a detected workspace whose directory
 * name has a space still runs where it was declared.
 */
describe("the target reference", () => {
  test("two tokens are the repo id and the label; the workspace stays absent", () => {
    expect(payloadFor("target.run", "r1 //src:lint")).toEqual({ payload: { repoId: "r1", label: "//src:lint" } })
    expect(payloadFor("target.open", "r1 //src:lint")).toEqual({ payload: { repoId: "r1", label: "//src:lint" } })
  })

  test("three tokens carry the workspace between the repo id and the label", () => {
    expect(payloadFor("target.run", "r1 aomi-sdk //:clippyFix")).toEqual({
      payload: { repoId: "r1", workspace: "aomi-sdk", label: "//:clippyFix" }
    })
  })

  test("a workspace path with a space keeps the last token as the label", () => {
    expect(payloadFor("target.run", "r1 my tools //:polish")).toEqual({
      payload: { repoId: "r1", workspace: "my tools", label: "//:polish" }
    })
  })

  test("a lone repo id is refused", () => {
    expect(payloadFor("target.run", "r1")).toEqual({ error: "target.run needs a repository id and a target label" })
  })
})

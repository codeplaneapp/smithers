import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { HtmlCardBody, inertHtmlDocument, TargetsCardBody } from "./TargetCards"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const targetsCard: Extract<Card, { kind: "targets" }> = {
  id: "targets-force",
  kind: "targets",
  title: "force targets",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repoId: "force",
    repoName: "force",
    status: "done",
    warnings: [],
    targets: [
      { id: "target-1", label: "//src:lint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "lint", workspace: "." }
    ]
  }
}

describe("trusted target cards", () => {
  test("a parent-owned Run button invokes the user-only target flow", () => {
    const calls: Array<[string, string | undefined]> = []
    const host = document.createElement("div")
    document.body.append(host)
    flushSync(() => {
      createRoot(host).render(
        <TargetsCardBody card={targetsCard} onRunCommand={(name, args) => calls.push([name, args])} />
      )
    })
    const run = host.querySelector('[data-flow="target.run"]') as HTMLButtonElement | null
    expect(run?.getAttribute("aria-label")).toBe("Run //src:lint")
    flushSync(() => run?.click())
    expect(calls).toEqual([["target.run", "force . //src:lint"]])
  })

  test("legacy HTML cards are scriptless and carry a network-denying CSP", () => {
    const document = inertHtmlDocument('<script>parent.postMessage({smithers:"run"},"*")</script><img src="https://evil.test/x">')
    expect(document).toContain("default-src 'none'")
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("evil.test"))

    const host = globalThis.document.createElement("div")
    globalThis.document.body.append(host)
    const card: Extract<Card, { kind: "html" }> = {
      id: "html-old",
      kind: "html",
      title: "Old panel",
      status: "acted",
      createdAt: 0,
      ordinal: 0,
      payload: { title: "Old panel", html: "<script>evil()</script>", source: "agent", repoId: "force" }
    }
    flushSync(() => createRoot(host).render(<HtmlCardBody card={card} />))
    const frame = host.querySelector("iframe")
    expect(frame?.getAttribute("sandbox")).toBe("")
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(frame?.hasAttribute("data-html-card")).toBe(false)
  })
})

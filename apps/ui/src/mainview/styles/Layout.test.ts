import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * Source-level pins for three layout defects, in the Contrast.test idiom (the
 * unit lane has no layout engine):
 *
 *  - base.css: a fixed 100vh shell with hidden overflow strands the composer
 *    under mobile browser chrome; dvh must follow the vh fallback.
 *  - cards.css: opacity-zero message actions stayed hit-testable — a touch
 *    tap in the corner landed on an invisible button. pointer-events tracks
 *    the visibility, and hover:none devices get a deliberate visible
 *    affordance.
 *  - chat.css: the 21rem nonshrinking devtools panel exceeds the 320px
 *    minimum shell width; below the panes' own 900px breakpoint it stacks.
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")

const base = read("base.css")
const cards = read("cards.css")
const chat = read("chat.css")

describe("the shell tracks the dynamic viewport, not the chrome-inflated one", () => {
  test("body and #root declare 100dvh after the 100vh fallback", () => {
    expect(base).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh;/)
    expect(base).toMatch(/height:\s*100vh;\s*height:\s*100dvh;/)
  })
})

describe("hidden message actions are not a touch trap", () => {
  test("opacity-zero actions take no pointer events", () => {
    const block = /\.message-actions\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(block).toContain("opacity: 0;")
    expect(block).toContain("pointer-events: none;")
  })

  test("hover and focus restore both visibility and hit-testing", () => {
    const block =
      /\.smithers-chat-message:hover \.message-actions,\s*\.message-actions:focus-within\s*\{[^}]*\}/.exec(cards)
        ?.[0] ?? ""
    expect(block).toContain("opacity: 1;")
    expect(block).toContain("pointer-events: auto;")
  })

  test("hover:none devices get the actions as a deliberate affordance", () => {
    expect(cards).toMatch(
      /@media \(hover: none\)\s*\{\s*\.message-actions\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/
    )
  })
})

describe("the pre-hydration server shell is styled, not bare markup", () => {
  /*
   * SessionShell.tsx renders before the client bundle hydrates, and its
   * classes appear in no client component — so a missing rule here is
   * invisible to every component test and shows only as ~800ms of unstyled
   * text on a cold web load.
   */
  test("base.css styles the server-session-shell and its message bubble", () => {
    expect(base).toMatch(/\.server-session-shell\s*\{/)
    const bubble = /\.server-session-shell p\s*\{[^}]*\}/.exec(base)?.[0] ?? ""
    expect(bubble).toContain("background: var(--bubble-incoming);")
    const link = /\.server-session-shell a\s*\{[^}]*\}/.exec(base)?.[0] ?? ""
    expect(link).toContain("border-radius: 999px;")
  })
})

describe("the devtools panel fits the 320px minimum shell", () => {
  test("the panel stacks under the chat column at the panes' 900px breakpoint", () => {
    expect(chat).toContain("@media (max-width: 900px)")
    expect(chat).toContain(".chat-frame:has(> .devtools-panel)")
    expect(chat).toMatch(/@media \(max-width: 900px\)[\s\S]*\.devtools-panel\s*\{[^}]*width:\s*100%;/)
  })
})

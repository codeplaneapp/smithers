import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import type { Card } from "../state/AppState"
import { contentKey, FileCardAddressLine, FileCardBody, isMarkdownPath } from "./FileCards"

/*
 * The file card's two renderings (will, 2026-09-01): a markdown file goes
 * through the shared WYSIWYG editor boundary, read only; every other text
 * file stays a fenced block. Binary and truncation notes are unchanged.
 */

GlobalRegistrator.register()

/*
 * Every root is unmounted synchronously before the globals leave: a root
 * left mounted keeps React scheduler work queued, and that work reads
 * `window` on a later macrotask — after unregister, it throws into whichever
 * test file bun runs next in the same process (seen: FilesSeam.test.ts
 * failing with "window is not defined" right after this file).
 */
const mounted: Array<{ readonly root: Root; readonly host: HTMLElement }> = []

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    flushSync(() => root.unmount())
    host.remove()
  }
})

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const fileCard = (path: string, content: string, extra: Partial<Extract<Card, { kind: "file" }>["payload"]> = {}): Extract<Card, { kind: "file" }> => ({
  id: `file-smithersai/smithers-${path}`,
  kind: "file",
  title: `File · smithersai/smithers · ${path}`,
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: { repo: "smithersai/smithers", path, content, truncated: false, ...extra }
})

const render = (card: Extract<Card, { kind: "file" }>): HTMLElement => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  flushSync(() => root.render(<FileCardBody card={card} onRunCommand={() => {}} />))
  return host
}

describe("the file card", () => {
  test("names markdown by extension, case-insensitively", () => {
    for (const path of ["README.md", "docs/guide.MD", "notes.markdown", "page.mdx"]) expect(isMarkdownPath(path)).toBe(true)
    for (const path of ["src/app.ts", "Makefile", "md", "readme.md.bak", "index.html"]) expect(isMarkdownPath(path)).toBe(false)
  })

  test("the editor's reset key follows the content, so a same-length edit reseeds the document", () => {
    expect(contentKey("# Smithers\n")).not.toBe(contentKey("# Smothers\n"))
    expect(contentKey("abc")).toBe(contentKey("abc"))
  })

  test("a markdown file renders through the read-only editor boundary, not a fenced block", () => {
    const host = render(fileCard("README.md", "# Smithers\n\nDurable agent workflows.\n"))
    expect(host.querySelector("pre")).toBeNull()
    const doc = host.querySelector("[data-file-markdown]")
    expect(doc).not.toBeNull()
    // The heavy adapter is lazy: the boundary's fallback (or the mounted editor) is what renders synchronously.
    expect(host.textContent).toContain("smithersai/smithers · README.md")
  })

  test("a non-markdown file stays a fenced block, and truncation is stated", () => {
    const host = render(fileCard("src/app.ts", "export const x = 1\n", { truncated: true }))
    expect(host.querySelector("pre")?.textContent).toBe("export const x = 1\n")
    expect(host.querySelector("[data-file-markdown]")).toBeNull()
    expect(host.textContent).toContain("Truncated")
  })

  /*
   * Ask 6 (will, 2026-09-02): "when we show a file it should be shown in a
   * panel with a reasonable max height that we can scroll within". The cap
   * itself is the .world-card-panel rule (styles/Layout.test.ts pins it);
   * what this holds is that the file body IS that panel — both renderings.
   */
  test("a file body is the scrolling panel, markdown and fenced alike", () => {
    const fenced = render(fileCard("src/main.ts", "export {}\n"))
    expect(fenced.querySelector(".world-card-panel")).not.toBeNull()
    expect(fenced.querySelector(".world-card-panel")?.contains(fenced.querySelector("pre"))).toBe(true)

    const markdown = render(fileCard("README.md", "# Title\n"))
    const panel = markdown.querySelector(".world-card-panel")
    expect(panel).not.toBeNull()
    expect(panel?.querySelector("[data-file-markdown]")).not.toBeNull()
  })

  test("a binary file is stated, never handed to the editor", () => {
    const host = render(fileCard("logo.md", "", { binary: true }))
    expect(host.querySelector("[data-file-markdown]")).toBeNull()
    expect(host.textContent).toContain("binary")
  })
})

/*
 * Code intelligence L1 (docs/code-intel/PLAN.md §1): a code file renders
 * through the lazy CodeSurface on `@pierre/diffs` `File`. The plain block is
 * the complete first state (the chunk, the grammar and the theme are async);
 * the token view replaces it. A file no grammar claims, and a truncated
 * file, keep the plain block: half a file is not highlighted.
 */
const codeView = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>('[data-slot="code-view"]')

const shadowOf = (host: HTMLElement): ShadowRoot | null => codeView(host)?.querySelector("diffs-container")?.shadowRoot ?? null

/** Poll until the lazy chunk mounted and pierre coloured a token; React settles between macrotasks. */
const highlighted = async (host: HTMLElement): Promise<void> => {
  for (let tick = 0; tick < 600 && shadowOf(host)?.querySelector("[data-line] span[style]") == null; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (shadowOf(host)?.querySelector("[data-line] span[style]") == null) throw new Error("the code view never painted a token")
}

describe("the file card's code view", () => {
  test("a code file shows the plain block first and the token view once the surface and grammar have loaded", async () => {
    const host = render(fileCard("src/app.ts", "export const answer: number = 42\n"))
    /*
     * The plain block is the complete first state whichever boundary owns it
     * at this moment: the Suspense fallback while the chunk loads, the
     * adapter's own block while the grammar loads (packages/smithers/ui pins the cold
     * sequence; here the chunk may already be warm from an earlier card).
     */
    expect(host.querySelector("pre")?.textContent).toBe("export const answer: number = 42\n")
    await highlighted(host)
    const view = codeView(host)
    expect(view?.getAttribute("data-language")).toBe("typescript")
    expect(view?.getAttribute("data-state")).toBe("ready")
    expect((shadowOf(host)?.querySelectorAll("[data-line] span[style]").length ?? 0) > 1).toBe(true)
    // The panel stays the one scroller: the view sits directly inside it, beside the address line.
    expect(view?.closest(".world-card-panel")).not.toBeNull()
    expect(host.textContent).not.toContain("Truncated")
  }, 30_000)

  test("a file no grammar claims keeps the plain block after the surface has loaded", async () => {
    // Warm the lazy boundary first so the second mount renders the real surface synchronously.
    await highlighted(render(fileCard("warm.ts", "let warm = 1\n")))
    const host = render(fileCard("LICENSE", "MIT License\n\nPermission is hereby granted\n"))
    expect(host.querySelector("pre.world-card-path")?.textContent).toBe("MIT License\n\nPermission is hereby granted\n")
    expect(codeView(host)).toBeNull()
  }, 30_000)

  test("a truncated code file keeps the plain block: half a file is not highlighted", async () => {
    await highlighted(render(fileCard("warm2.ts", "let warm = 2\n")))
    const host = render(fileCard("src/big.ts", "export const cut = 1\n", { truncated: true }))
    expect(host.querySelector("pre.world-card-path")?.textContent).toBe("export const cut = 1\n")
    expect(codeView(host)).toBeNull()
    expect(host.textContent).toContain("Truncated")
  }, 30_000)

  test("the anchored line rides the panel as data-line and is the selected line in the view", async () => {
    const host = render(fileCard("src/anchor.ts", "const a = 1\nconst b = 2\nconst c = 3\n", { line: 2, column: 7 }))
    expect(host.querySelector(".world-card-panel")?.getAttribute("data-line")).toBe("2")
    await highlighted(host)
    expect(shadowOf(host)?.querySelector('[data-line="2"]')?.hasAttribute("data-selected-line")).toBe(true)
    expect(shadowOf(host)?.querySelectorAll("[data-line][data-selected-line]")).toHaveLength(1)
  }, 30_000)
})


/*
 * Code intelligence L4 (docs/code-intel/PLAN.md §5): the card projects the
 * payload the code-intel seam writes — language word, diagnostics count and
 * rows, the hover answer, the server state — and binds the two pointer
 * gestures to code.hover and code.definition through onRunCommand, the same
 * door every row in this file uses. Nothing here is component state: a
 * payload with the field shows the element, a payload without it shows
 * nothing.
 */
const diagnostic = (line: number, severity: "error" | "warning" | "information" | "hint", message: string) => ({
  line,
  character: 7,
  endLine: line,
  endCharacter: 13,
  severity,
  message,
  source: "ts",
  code: "2551"
})

const renderWith = (card: Extract<Card, { kind: "file" }>): { readonly host: HTMLElement; readonly calls: Array<[string, string | undefined]> } => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  flushSync(() => root.render(<FileCardBody card={card} onRunCommand={(name, args) => calls.push([name, args])} />))
  return { host, calls }
}

const tokenIn = (host: HTMLElement, line: number, text: string): HTMLElement => {
  const span = Array.from(shadowOf(host)?.querySelectorAll<HTMLElement>(`[data-line="${line}"] [data-char]`) ?? []).find((candidate) =>
    candidate.textContent === text
  )
  if (span === undefined) throw new Error(`no token "${text}" on line ${line}`)
  return span
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("the file card's code intelligence", () => {
  test("the header names the language of a code file and says nothing for a file no grammar claims", () => {
    expect(render(fileCard("src/app.ts", "export {}\n")).querySelector('[data-slot="code-language"]')?.textContent).toBe("TypeScript")
    expect(render(fileCard("src/App.tsx", "export {}\n")).querySelector('[data-slot="code-language"]')?.textContent).toBe("TSX")
    expect(render(fileCard("LICENSE", "MIT\n")).querySelector('[data-slot="code-language"]')).toBeNull()
  })

  test("the diagnostics count line exists only once the server answered, and counts errors and warnings", () => {
    expect(render(fileCard("src/app.ts", "export {}\n")).querySelector('[data-slot="code-diagnostics-count"]')).toBeNull()
    expect(render(fileCard("src/app.ts", "export {}\n", { diagnostics: [] })).querySelector('[data-slot="code-diagnostics-count"]')?.textContent).toBe(
      "0 errors · 0 warnings"
    )
    const mixed = render(
      fileCard("src/app.ts", "export {}\n", {
        diagnostics: [diagnostic(1, "error", "e"), diagnostic(1, "warning", "w1"), diagnostic(1, "warning", "w2"), diagnostic(1, "hint", "h")]
      })
    )
    expect(mixed.querySelector('[data-slot="code-diagnostics-count"]')?.textContent).toBe("1 error · 2 warnings")
  })

  test("a diagnostic renders under its line with its severity, message and origin", async () => {
    const host = render(
      fileCard("src/app.ts", "const message = 'x'\nconst length = message.lenght\n", {
        diagnostics: [diagnostic(2, "error", "Property 'lenght' does not exist on type 'string'.")]
      })
    )
    await highlighted(host)
    const row = host.querySelector<HTMLElement>('[data-slot="code-diagnostic"]')
    expect(row?.textContent).toContain("Property 'lenght' does not exist on type 'string'.")
    expect(row?.textContent).toContain("(ts 2551)")
    expect(row?.getAttribute("data-severity")).toBe("error")
    expect(row?.closest("[slot]")?.getAttribute("slot")).toBe("annotation-2")
  }, 30_000)

  test("the hover answer renders under its line as markdown; a null or absent hover renders nothing", async () => {
    const host = render(
      fileCard("src/app.ts", "export const answer: number = 42\n", {
        hover: { line: 1, character: 14, contents: "```typescript\nconst answer: number\n```\n" }
      })
    )
    await highlighted(host)
    const box = host.querySelector<HTMLElement>('[data-slot="code-hover"]')
    expect(box?.textContent).toContain("const answer: number")
    expect(box?.textContent).not.toContain("```")
    expect(box?.closest("[slot]")?.getAttribute("slot")).toBe("annotation-1")
    expect(render(fileCard("src/b.ts", "export {}\n", { hover: null })).querySelector('[data-slot="code-hover"]')).toBeNull()
    expect(render(fileCard("src/c.ts", "export {}\n")).querySelector('[data-slot="code-hover"]')).toBeNull()
  }, 30_000)

  test("the server state is stated only when it is not ready: missing with its install line, unavailable with the host's message, starting", () => {
    const missing = render(fileCard("src/app.ts", "export {}\n", { intel: { state: "missing", note: "npm i -g typescript-language-server typescript" } }))
    const note = missing.querySelector('[data-intel="missing"]')
    expect(note?.textContent).toContain("no TypeScript language server on this machine")
    expect(note?.textContent).toContain("Install: npm i -g typescript-language-server typescript")
    expect(render(fileCard("src/app.ts", "export {}\n", { intel: { state: "unavailable", note: "the language server exited" } })).querySelector('[data-intel="unavailable"]')?.textContent)
      .toContain("the language server exited")
    expect(render(fileCard("src/app.ts", "export {}\n", { intel: { state: "starting" } })).querySelector('[data-intel="starting"]')?.textContent)
      .toContain("Starting the TypeScript language server")
    expect(render(fileCard("src/app.ts", "export {}\n", { intel: { state: "ready" } })).querySelector("[data-intel]")).toBeNull()
    expect(render(fileCard("src/app.ts", "export {}\n")).querySelector("[data-intel]")).toBeNull()
  })

  test("a pointer at rest on a token runs code.hover at the token's position; ⌘-click runs code.definition; both are data-flow bindings", async () => {
    const { host, calls } = renderWith(fileCard("src/app.ts", "export const answer: number = 42\n"))
    await highlighted(host)
    const surface = host.querySelector('[data-flow="code.hover"]')
    expect(surface).not.toBeNull()
    expect(surface?.getAttribute("data-flow-activate")).toBe("code.definition")
    // `answer` starts at the 14th character of line 1.
    const answer = tokenIn(host, 1, "answer")
    answer.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }))
    expect(calls).toEqual([])
    await wait(400)
    expect(calls).toEqual([["code.hover", "src/app.ts:1:14 smithersai/smithers"]])
    answer.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }))
    expect(calls[1]).toEqual(["code.definition", "src/app.ts:1:14 smithersai/smithers"])
    answer.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }))
    expect(calls).toHaveLength(2)
  }, 30_000)

  test("one hover in flight: a position already asked, or already answered, is not asked again; a new position is", async () => {
    const card = fileCard("src/app.ts", "export const answer: number = 42\n")
    const { host, calls } = renderWith(card)
    await highlighted(host)
    const answer = tokenIn(host, 1, "answer")
    const rest = async (token: HTMLElement): Promise<void> => {
      token.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" }))
      await wait(400)
      token.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, composed: true, pointerType: "mouse" }))
    }
    await rest(answer)
    await rest(answer)
    expect(calls).toEqual([["code.hover", "src/app.ts:1:14 smithersai/smithers"]])
    // The answer lands on the payload: resting there again asks nothing.
    const root = mounted[mounted.length - 1]!.root
    flushSync(() =>
      root.render(
        <FileCardBody
          card={{ ...card, payload: { ...card.payload, hover: { line: 1, character: 14, contents: "const answer: number" } } }}
          onRunCommand={(name, args) => calls.push([name, args])}
        />
      )
    )
    await rest(tokenIn(host, 1, "answer"))
    expect(calls).toHaveLength(1)
    await rest(tokenIn(host, 1, "42"))
    expect(calls[1]).toEqual(["code.hover", "src/app.ts:1:31 smithersai/smithers"])
  }, 30_000)
})

describe("the address line's head-moved rule", () => {
  const line = (source: "head" | "working-copy" | undefined): string => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    flushSync(() =>
      root.render(
        <FileCardAddressLine
          repo="smithersai/smithers"
          path="README.md"
          address="/smithersai/smithers/README.md"
          readAt={{ changeId: "qupxosqw", commitId: "aaaa1111", ...(source === undefined ? {} : { source }) }}
          head={{ changeId: "ronvznsk", commitId: "bbbb2222" }}
          refreshCommand="files.read"
          onRunCommand={() => {}}
        />
      )
    )
    return host.textContent ?? ""
  }
  test("a read at the head reports head moved when the head commit differs", () => {
    expect(line("head")).toContain("head moved")
    expect(line(undefined)).toContain("head moved")
  })
  test("a working-copy read never reports head moved: its drift is the origin chip's N ahead", () => {
    expect(line("working-copy")).not.toContain("head moved")
  })
})

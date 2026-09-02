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

  test("a binary file is stated, never handed to the editor", () => {
    const host = render(fileCard("logo.md", "", { binary: true }))
    expect(host.querySelector("[data-file-markdown]")).toBeNull()
    expect(host.textContent).toContain("binary")
  })
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

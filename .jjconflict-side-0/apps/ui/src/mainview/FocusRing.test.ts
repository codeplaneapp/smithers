import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { focusableOutside, tabOutOf } from "./FocusRing"

/*
 * §21.2: the world editor is a ProseMirror body and ProseMirror binds Tab to
 * "insert indentation", so forward Tab never left it. The host restores the
 * document's own Tab order around the region.
 */

GlobalRegistrator.register()

afterAll(() => {
  void GlobalRegistrator.unregister()
})

const layout = (html: string): { region: HTMLElement } => {
  document.body.innerHTML = html
  const region = document.querySelector<HTMLElement>("#region")
  if (region === null) throw new Error("the fixture has no #region")
  return { region }
}

const press = (key: string, shiftKey = false) => {
  let prevented = false
  return {
    event: {
      key,
      shiftKey,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => {
        prevented = true
      }
    },
    wasPrevented: () => prevented
  }
}

describe("tabbing out of a region that eats Tab", () => {
  test("forward Tab lands on the next stop after the region", () => {
    const { region } = layout(`
			<button id="before">before</button>
			<div id="region"><div tabindex="0" id="editor">body</div></div>
			<button id="after">after</button>
		`)
    expect(focusableOutside(region, false)?.id).toBe("after")
  })

  test("Shift+Tab lands on the last stop before the region", () => {
    const { region } = layout(`
			<button id="before">before</button>
			<div id="region"><div tabindex="0" id="editor">body</div></div>
			<button id="after">after</button>
		`)
    expect(focusableOutside(region, true)?.id).toBe("before")
  })

  test("a region that is last in the document wraps forward rather than trapping", () => {
    // This is exactly the world surface: the editor is the final region.
    const { region } = layout(`
			<button id="first">first</button>
			<button id="second">second</button>
			<div id="region"><div tabindex="0" id="editor">body</div></div>
		`)
    expect(focusableOutside(region, false)?.id).toBe("first")
  })

  test("stops inside the region are never the answer", () => {
    const { region } = layout(`
			<div id="region"><button id="inner">inner</button></div>
			<button id="after">after</button>
		`)
    expect(focusableOutside(region, false)?.id).toBe("after")
    expect(focusableOutside(region, true)?.id).toBe("after")
  })

  test("tabOutOf takes a bare Tab and moves focus", () => {
    const { region } = layout(`
			<div id="region"><div tabindex="0" id="editor">body</div></div>
			<button id="after">after</button>
		`)
    const tab = press("Tab")
    expect(tabOutOf(tab.event, region)).toBe(true)
    expect(tab.wasPrevented()).toBe(true)
    expect(document.activeElement?.id).toBe("after")
  })

  test("tabOutOf leaves every other key, and a modified Tab, to the region", () => {
    const { region } = layout(`
			<div id="region"><div tabindex="0" id="editor">body</div></div>
			<button id="after">after</button>
		`)
    const enter = press("Enter")
    expect(tabOutOf(enter.event, region)).toBe(false)
    expect(enter.wasPrevented()).toBe(false)
    const modified = { ...press("Tab").event, metaKey: true }
    expect(tabOutOf(modified, region)).toBe(false)
  })

  test("a document with nothing else focusable keeps the press", () => {
    const { region } = layout(`<div id="region"><div tabindex="0" id="editor">body</div></div>`)
    const tab = press("Tab")
    expect(tabOutOf(tab.event, region)).toBe(false)
    expect(tab.wasPrevented()).toBe(false)
  })
})

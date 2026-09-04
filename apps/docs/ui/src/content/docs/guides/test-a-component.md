---
title: "Test a component"
description: "Run the package suite, register happy-dom before Radix loads, choose between static markup and a real root, and keep injected stylesheets from leaking between tests."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/ui/docs/guides/test-a-component.md"
---

The suite runs on Bun against a happy-dom registrator. This guide covers the two
rendering shapes, the one preload that has to exist, and the cleanup that keeps
tests independent.

## Run the gates

```bash
pnpm --filter @smthrs/ui test    # bun test tests
pnpm --filter @smthrs/ui run check    # tsc -p tsconfig.json --noEmit
```

Both are declared in `PACKAGE.ts` as `//packages/smithers/ui:unitTests` and
`//packages/smithers/ui:check`. This package runs neither vitest nor eslint nor
dprint, and `PACKAGE.ts` records why: it ships its sources directly, types
against `@types/bun`, and satisfies none of the standard library-build synthesis.

The typecheck is not optional in the way it is for a package that ships a build.
Every export condition points at a `.ts` or `.tsx` source, so `tsc --noEmit` is
the only thing between a type error and a consumer's build.

## Register happy-dom in a preload, not a test file

Radix resolves its server-safe `useLayoutEffect` shim at module load time. With
no `globalThis.document` at that moment, every Radix layout effect becomes a
no-op for the rest of the process, and portal content never appears, even if you
register happy-dom a line later. ESM imports hoist above any in-file
registration call, so the registration must happen before any test file imports
`radix-ui`.

That is what `bunfig.toml` is for:

```toml
[test]
preload = ["./tests/happy-dom-preload.ts"]
```

The preload registers the global DOM and disables happy-dom's iframe page
loading, because iframe-rendering tests would otherwise perform real network
fetches that hang in a networkless sandbox.

## Assert on markup when the question is markup

`renderToStaticMarkup` is the cheapest shape and works for anything that does
not need effects, state, or portals:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Button, SmithersUiStyles } from "@smthrs/ui"

test("the default button wears the house tinted recipe", () => {
  const html = renderToStaticMarkup(
    <>
      <SmithersUiStyles />
      <Button>Launch</Button>
    </>
  )
  expect(html).toContain('data-slot="button"')
  expect(html).toContain("sui-button-default")
})
```

Prefer `data-slot` over a class name when you are asserting on a part rather
than on styling.

## Mount a real root when behavior is the question

Radix portals, focus management, controlled state, and effects need a real root
and React's act environment:

```tsx
import { afterEach, expect, test } from "bun:test"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { SMITHERS_UI_STYLE_ATTR, Tabs, TabsContent, TabsList, TabsTrigger } from "@smthrs/ui"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement | undefined
let root: Root | undefined

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const created = root
  await act(async () => created.render(element))
}

afterEach(async () => {
  if (root) {
    const created = root
    await act(async () => created.unmount())
    root = undefined
  }
  container?.remove()
  container = undefined
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove())
})

test("the selected tab renders its panel", async () => {
  await render(
    <Tabs defaultValue="runs">
      <TabsList>
        <TabsTrigger value="runs">Runs</TabsTrigger>
      </TabsList>
      <TabsContent value="runs">Nothing running</TabsContent>
    </Tabs>
  )
  expect(container?.textContent).toContain("Nothing running")
})
```

The stylesheet cleanup in `afterEach` matters. Every component injects the sheet
into `document.head` on mount, and the document is shared across every test in
the process. Removing `style[data-smithers-ui]` keeps one test's injection from
deciding whether the next test's injector stands down.

## Test against a theme

Computed styles need the token block, which the component sheet does not carry
on its own. Compose both and install them:

```ts
import { composeSmithersUiStyles } from "@smthrs/ui"

function installThemeStyles(): void {
  const style = document.createElement("style")
  style.setAttribute("data-theme-test", "")
  style.textContent = composeSmithersUiStyles({ withTheme: true })
  document.head.appendChild(style)
}
```

Then drive the mode with the attribute the components read:

```ts
document.documentElement.setAttribute("data-theme", "dark")
```

Remove the element and the attribute afterwards, for the same reason as above.

## Guard a guard

Two suites in this package are worth copying as a pattern rather than as code.

`tests/barrel-weight.test.ts` asserts that heavy dependencies are absent from
the bundled base barrel. A negative assertion passes against an empty bundle, so
it also asserts a minimum size and the presence of `node_modules/react`, and
bundles a control entry point that must contain the dependency. Write both
halves whenever you assert that something is missing.

`tests/docs-links.test.ts` scans every Markdown file in the package and fails on
a relative link whose target does not exist. It then pins the scanner itself
against the link forms it must catch and the ones it must ignore, because a
scanner that silently matches nothing is the failure being guarded against.

## Related

- [The adapters boundary](/concepts/adapters/): what the bundle ratchet
  measures and why it runs in a subprocess.
- [How styling ships](/concepts/styling/): why the sheet reaches the
  document twice.

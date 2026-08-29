/**
 * The router is the whole authoring contract: where a file sits is the only
 * thing that names it. These tests build throwaway app trees on disk and check
 * what `discover` reads back, because a rule that only holds for this
 * repository's layout is not a rule.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { defaultDirs } from "../src/app.ts"
import { discover, render, renderAll, renderUi, resolveLayer, RouterError, writeRoutes } from "../src/router.ts"

const roots: Array<string> = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** Writes an app tree from a `relative path -> contents` map and returns its root. */
const appTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-router-"))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

const dirs = defaultDirs
const layers = {
  "AGENT.ts": "export const Agent = {}\n",
  "SANDBOX.ts": "export const Sandbox = {}\n",
  "TOOLS.ts": "export const Tools = {}\n"
}

describe("discover", () => {
  it("names pages, panes, and flows by location", () => {
    const root = appTree({
      ...layers,
      "app/layout.tsx": "export default () => null\n",
      "app/page.tsx": "export default () => null\n",
      "app/build/page.tsx": "export default () => null\n",
      "app/operate/transactions/page.tsx": "export default () => null\n",
      "app/panes/balances.tsx": "export const Pane = {}\n",
      "app/panes/tx-receipt.tsx": "export const Pane = {}\n",
      "flows/chat/flow.ts": "export const Flow = {}\n",
      "flows/build/plan/flow.ts": "export const Flow = {}\n",
      // Not routed: no `page.tsx`, no `flow.ts`, wrong directory.
      "app/build/build-view.tsx": "export const View = {}\n",
      "src/api.ts": "export const Routes = {}\n",
      "tools/tevm.ts": "export const tevm = {}\n"
    })
    const routes = discover({ root, dirs })

    expect(routes.layout).toBe("app/layout.tsx")
    expect(routes.pages).toEqual([
      { route: "/build", file: "app/build/page.tsx" },
      { route: "/operate/transactions", file: "app/operate/transactions/page.tsx" },
      { route: "/", file: "app/page.tsx" }
    ])
    expect(routes.panes).toEqual([
      { name: "balances", file: "app/panes/balances.tsx" },
      { name: "tx-receipt", file: "app/panes/tx-receipt.tsx" }
    ])
    expect(routes.flows.map((flow) => flow.id)).toEqual(["build/plan", "chat"])
  })

  it("routes a flow.mdx the same as a flow.ts", () => {
    const root = appTree({ ...layers, "flows/notes/flow.mdx": "# notes\n" })
    expect(discover({ root, dirs }).flows).toEqual([
      { id: "notes", file: "flows/notes/flow.mdx", agent: "AGENT.ts", sandbox: "SANDBOX.ts", tools: "TOOLS.ts" }
    ])
  })

  it("reports no layout as undefined, not as an error", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    expect(discover({ root, dirs }).layout).toBeUndefined()
  })

  it("ignores node_modules and build output", () => {
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "node_modules/pkg/app/panes/fake.tsx": "export const Pane = {}\n",
      "dist/app/page.tsx": "export default () => null\n",
      ".wrangler/app/panes/tmp.tsx": "export const Pane = {}\n"
    })
    const routes = discover({ root, dirs })
    expect(routes.panes).toEqual([])
    expect(routes.pages).toEqual([{ route: "/", file: "app/page.tsx" }])
  })

  it("honors non-default dirs", () => {
    const root = appTree({
      ...layers,
      "site/page.tsx": "export default () => null\n",
      "pipelines/chat/flow.ts": "export const Flow = {}\n"
    })
    const routes = discover({ root, dirs: { app: "site", flows: "pipelines", tools: "tools" } })
    expect(routes.pages).toEqual([{ route: "/", file: "site/page.tsx" }])
    expect(routes.flows.map((flow) => flow.id)).toEqual(["chat"])
  })
})

describe("layer resolution", () => {
  it("resolves the nearest ancestor AGENT.ts and merges nothing", () => {
    const root = appTree({
      ...layers,
      "flows/chat/flow.ts": "export const Flow = {}\n",
      "flows/build/AGENT.ts": "export const Agent = {}\n",
      "flows/build/flow.ts": "export const Flow = {}\n",
      "flows/build/plan/flow.ts": "export const Flow = {}\n"
    })
    const byId = new Map(discover({ root, dirs }).flows.map((flow) => [flow.id, flow]))

    expect(byId.get("chat")!.agent).toBe("AGENT.ts")
    // The override applies to its own directory and everything below it.
    expect(byId.get("build")!.agent).toBe("flows/build/AGENT.ts")
    expect(byId.get("build/plan")!.agent).toBe("flows/build/AGENT.ts")
    // Only AGENT.ts was overridden; the other two kinds still resolve to root.
    expect(byId.get("build")!.sandbox).toBe("SANDBOX.ts")
    expect(byId.get("build")!.tools).toBe("TOOLS.ts")
  })

  it("resolves each kind independently", () => {
    const root = appTree({
      ...layers,
      "flows/build/TOOLS.ts": "export const Tools = {}\n",
      "flows/build/flow.ts": "export const Flow = {}\n"
    })
    const flow = discover({ root, dirs }).flows[0]!
    expect(flow).toEqual({
      id: "build",
      file: "flows/build/flow.ts",
      agent: "AGENT.ts",
      sandbox: "SANDBOX.ts",
      tools: "flows/build/TOOLS.ts"
    })
  })

  it("refuses a flow with no ancestor layer", () => {
    const root = appTree({
      "SANDBOX.ts": layers["SANDBOX.ts"],
      "TOOLS.ts": layers["TOOLS.ts"],
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError)
      expect((error as RouterError).name).toBe("RouterError")
      expect((error as RouterError).code).toBe("missing_layer")
      expect((error as RouterError).message).toContain("no AGENT.ts found for flows/chat")
      expect((error as RouterError).message).toContain("add one at the app root")
    }
  })

  it("resolves a layer at the root itself", () => {
    const root = appTree(layers)
    expect(resolveLayer(root, root, "AGENT.ts", new Set(["AGENT.ts"]))).toBe("AGENT.ts")
  })
})

describe("name collisions", () => {
  it("refuses flow.ts and flow.mdx in one directory", () => {
    const root = appTree({
      ...layers,
      "flows/chat/flow.ts": "export const Flow = {}\n",
      "flows/chat/flow.mdx": "# chat\n"
    })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("duplicate_name")
      expect((error as RouterError).message).toBe(
        "flows/chat/flow.ts and flows/chat/flow.mdx both resolve to flow:chat"
      )
    }
  })

  it("refuses an uppercase pane file name", () => {
    const root = appTree({ ...layers, "app/panes/Balances.tsx": "export const Pane = {}\n" })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("invalid_name")
    }
  })

  it("refuses an uppercase flow directory", () => {
    const root = appTree({ ...layers, "flows/Chat/flow.ts": "export const Flow = {}\n" })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("invalid_name")
    }
  })
})

describe("render", () => {
  it("emits routes.gen.ts and routes.ui.gen.ts", () => {
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "app/panes/balances.tsx": "export const Pane = {}\n",
      "flows/build/AGENT.ts": "export const Agent = {}\n",
      "flows/build/flow.ts": "export const Flow = {}\n",
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    const expectedRuntime = [
      "// Generated by @smthrs/create-app from the flows and layer files. Do not edit.",
      "// Regenerate with `pnpm routes`; `smthrs '//:routes'` checks for drift.",
      "/* eslint-disable */",
      "",
      "import * as layer0 from \"./AGENT.ts\"",
      "import * as layer1 from \"./SANDBOX.ts\"",
      "import * as layer2 from \"./TOOLS.ts\"",
      "import * as layer3 from \"./flows/build/AGENT.ts\"",
      "import * as flow_build from \"./flows/build/flow.ts\"",
      "import * as flow_chat from \"./flows/chat/flow.ts\"",
      "",
      "export const paneNames = [\"balances\"] as const",
      "",
      "export const flows = [",
      "  { id: \"build\", file: \"flows/build/flow.ts\", spec: flow_build.Flow, agent: layer3.Agent, " +
      "sandbox: layer1.Sandbox, tools: layer2.Tools },",
      "  { id: \"chat\", file: \"flows/chat/flow.ts\", spec: flow_chat.Flow, agent: layer0.Agent, " +
      "sandbox: layer1.Sandbox, tools: layer2.Tools },",
      "] as const",
      ""
    ].join("\n")
    const expectedUi = [
      "// Generated by @smthrs/create-app from the app directory. Do not edit.",
      "// Regenerate with `pnpm routes`; `smthrs '//:routes'` checks for drift.",
      "/* eslint-disable */",
      "",
      "import * as pane_balances from \"./app/panes/balances.tsx\"",
      "import * as page__ from \"./app/page.tsx\"",
      "",
      "export const layout = undefined",
      "",
      "export const pages = [",
      "  { route: \"/\", file: \"app/page.tsx\", component: page__.default },",
      "] as const",
      "",
      "export const panes = {",
      "  \"balances\": pane_balances.Pane,",
      "} as const",
      ""
    ].join("\n")

    const routes = discover({ root, dirs })
    expect(render(routes)).toBe(expectedRuntime)
    expect(renderUi(routes)).toBe(expectedUi)
    expect(renderAll(routes)).toEqual({ "routes.gen.ts": expectedRuntime, "routes.ui.gen.ts": expectedUi })
  })

  it("renders empty tables for an empty app, not a broken file", () => {
    const root = appTree(layers)
    const routes = discover({ root, dirs })
    const runtime = render(routes)
    const ui = renderUi(routes)
    expect(runtime).toContain("export const paneNames = [] as const")
    expect(runtime).toContain("export const flows = [\n] as const")
    expect(ui).toContain("export const layout = undefined")
    expect(ui).toContain("export const pages = [\n] as const")
    expect(ui).toContain("export const panes = {\n} as const")
  })

  it("renders identically for two identical trees", () => {
    const files = {
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "flows/chat/flow.ts": "export const Flow = {}\n"
    }
    const first = render(discover({ root: appTree(files), dirs }))
    const second = render(discover({ root: appTree(files), dirs }))
    expect(first).toBe(second)
  })

  it("exports a layout without shadowing its own import", () => {
    // The namespace import and the export must not share an identifier, or the
    // generated file is a redeclaration TypeScript rejects.
    const root = appTree({ ...layers, "app/layout.tsx": "export default () => null\n" })
    const output = renderUi(discover({ root, dirs }))
    expect(output).toContain("import * as layoutModule from \"./app/layout.tsx\"")
    expect(output).toContain("export const layout = layoutModule.default")
    expect(output).not.toContain("import * as layout from")
  })
})

describe("writeRoutes", () => {
  it("writes both files, then reports them clean on a second run", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const first = writeRoutes({ root, dirs })
    expect(first.files).toEqual({ "routes.gen.ts": "written", "routes.ui.gen.ts": "written" })
    expect(first.stale).toEqual([])
    expect(first.counts).toEqual({ pages: 1, panes: 0, flows: 0 })
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("app/page.tsx")

    const second = writeRoutes({ root, dirs })
    expect(second.files).toEqual({ "routes.gen.ts": "clean", "routes.ui.gen.ts": "clean" })
  })

  it("reports drift and writes nothing in check mode", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const report = writeRoutes({ root, dirs, check: true })
    expect(report.stale).toEqual(["routes.gen.ts", "routes.ui.gen.ts"])
    expect(report.files).toEqual({ "routes.gen.ts": "stale", "routes.ui.gen.ts": "stale" })
    expect(() => readFileSync(join(root, "routes.gen.ts"), "utf8")).toThrow()
  })

  it("reports a checked, already-current tree as clean", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    writeRoutes({ root, dirs })
    const report = writeRoutes({ root, dirs, check: true })
    expect(report.stale).toEqual([])
    expect(report.files).toEqual({ "routes.gen.ts": "clean", "routes.ui.gen.ts": "clean" })
  })
})

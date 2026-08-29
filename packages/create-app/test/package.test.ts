/**
 * `CreateApp` is the one call an app's PACKAGE.ts makes, so what it derives —
 * the manifest defaults and the five target declarations — is the app's whole
 * build surface. The assertions read target attributes rather than executing
 * anything: an app that declares the wrong data set or the wrong write set
 * fails at plan time, not at run time.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Target from "@smthrs/targets/Target"
import { type Brand, CreateApp } from "../src/index.ts"

const brand: Brand = { name: "Ledger", tokens: { accent: "#5288c2" } }

const app = (overrides: Partial<Parameters<typeof CreateApp>[0]> = {}) =>
  CreateApp({
    name: "ledger",
    brand,
    deploy: { cloudflare: { workerName: "ledger-worker", domain: "ledger.example.com" } },
    ...overrides
  })

describe("manifest", () => {
  it("fills the directory layout, the navigation, and the wrangler path", () => {
    expect(app().manifest).toEqual({
      name: "ledger",
      brand,
      nav: [],
      dirs: { app: "app", flows: "flows", tools: "tools" },
      deploy: {
        cloudflare: {
          workerName: "ledger-worker",
          domain: "ledger.example.com",
          config: "worker/wrangler.jsonc"
        }
      }
    })
  })

  it("takes a partial dirs override without losing the other two", () => {
    expect(app({ dirs: { app: "site" } }).manifest.dirs).toEqual({ app: "site", flows: "flows", tools: "tools" })
  })

  it("keeps a declared wrangler config and navigation", () => {
    const nav = [{ label: "Operate", items: [{ label: "Logs", href: "/operate/logs", icon: "scroll" }] }]
    const targets = app({
      nav,
      deploy: { cloudflare: { workerName: "w", domain: "d.example.com", config: "infra/wrangler.jsonc" } }
    })
    expect(targets.manifest.nav).toEqual(nav)
    expect(targets.manifest.deploy.cloudflare.config).toBe("infra/wrangler.jsonc")
  })
})

describe("targets", () => {
  it("generates both route tables from the package's own bin", () => {
    const attrs = Target.metadata(app().routes).attrs as {
      readonly bin: { readonly package: string; readonly bin: string }
      readonly changes: ReadonlyArray<string>
    }
    expect(attrs.bin).toMatchObject({ package: "@smthrs/create-app", bin: "smthrs-routes" })
    expect(attrs.changes).toEqual(["routes.gen.ts", "routes.ui.gen.ts"])
  })

  it("keys the route tables on the routed files and PACKAGE.ts, and on nothing else", () => {
    const attrs = Target.metadata(app({ dirs: { app: "site", flows: "pipelines" } }).routes).attrs as {
      readonly data: readonly [ReadonlyArray<{ readonly pattern: string }>, { readonly path: string }]
    }
    expect(attrs.data[0].map((glob) => glob.pattern)).toEqual([
      "site/**/page.tsx",
      "site/layout.tsx",
      "site/panes/*.tsx",
      "pipelines/**/flow.ts",
      "pipelines/**/flow.mdx",
      "**/AGENT.ts",
      "**/SANDBOX.ts",
      "**/TOOLS.ts"
    ])
    expect(attrs.data[1].path).toBe("//PACKAGE.ts")
  })

  it("serves on the port it waits for, with the network open", () => {
    const attrs = Target.metadata(app().dev).attrs as {
      readonly args: ReadonlyArray<string>
      readonly readiness: { readonly port: number }
      readonly sandbox: { readonly network: boolean }
    }
    expect(attrs.args).toEqual(["--port", "5173"])
    expect(attrs.readiness.port).toBe(5173)
    expect(attrs.sandbox.network).toBe(true)
  })

  it("builds into dist", () => {
    const attrs = Target.metadata(app().build).attrs as { readonly outDirs: ReadonlyArray<string> }
    expect(attrs.outDirs).toEqual(["dist"])
  })

  it("gates deploy on the build and requires approval and both credentials", () => {
    const attrs = Target.metadata(app().deploy).attrs as {
      readonly args: ReadonlyArray<string>
      readonly approval: string
      readonly gates: ReadonlyArray<unknown>
      readonly secrets: ReadonlyArray<{ readonly env: string }>
    }
    // No `--config`: wrangler follows the vite plugin's deploy redirect only
    // when the flag is absent.
    expect(attrs.args).toEqual(["deploy"])
    expect(attrs.approval).toBe("required")
    expect(attrs.gates).toHaveLength(1)
    expect(attrs.secrets.map((secret) => secret.env)).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
  })
})

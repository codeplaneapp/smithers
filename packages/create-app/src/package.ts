/**
 * The Node half of the authoring surface: `CreateApp`.
 *
 * `CreateApp` turns one declaration into the app manifest plus the four
 * targets an app needs — regenerate the route tables, serve, build, deploy.
 * Every target is an ordinary `@smthrs/targets` rule, so an app runs on the
 * `smthrs` CLI without a new target kind.
 *
 * Only `PACKAGE.ts` imports this module. The browser and Worker bundles import
 * `@smthrs/create-app/app`, which pulls in no build rules.
 *
 * @since 0.1.0
 */
import { Smithers as S } from "@smthrs/targets"
import { type AppDirs, type AppManifest, type Brand, type CloudflareDeploy, defaultDirs, type NavGroup } from "./app.ts"

/**
 * What `CreateApp` is given: the brand, the navigation, the source layout, and
 * where the app deploys.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateAppOptions {
  readonly name: string
  readonly brand: Brand
  readonly nav?: ReadonlyArray<NavGroup>
  readonly dirs?: Partial<AppDirs>
  readonly deploy: { readonly cloudflare: CloudflareDeploy }
}

/**
 * What `CreateApp` returns: the manifest the Vite plugin serves, and the four
 * targets `PACKAGE.ts` puts in its target map.
 *
 * @category models
 * @since 0.1.0
 */
export interface AppTargets {
  readonly manifest: AppManifest
  /** Regenerates `routes.gen.ts` and `routes.ui.gen.ts`; checks drift without `--write`. */
  readonly routes: ReturnType<typeof S.Generate>
  /** `vite` with workerd in the loop. */
  readonly dev: ReturnType<typeof S.Shell.Serve>
  /** `vite build`, producing the Worker bundle and the static assets. */
  readonly build: ReturnType<typeof S.Shell.Build>
  /** `wrangler deploy`: approval required, network on, credentials as named secrets. */
  readonly deploy: ReturnType<typeof S.Shell.Run>
}

/** The wrangler config every app gets when it declares no path of its own. */
const defaultWranglerConfig = "worker/wrangler.jsonc"

/** The port `dev` serves on and waits for. */
const devPort = 5173

/**
 * Declares a Smithers app.
 *
 * @example
 * ```ts
 * import { CreateApp } from "@smthrs/create-app"
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const App = CreateApp({
 *   name: "ledger",
 *   brand: { name: "Ledger", tokens: { accent: "#5288c2" } },
 *   deploy: { cloudflare: { workerName: "ledger", domain: "ledger.example.com" } }
 * })
 *
 * export const Package = S.Package({
 *   targets: { routes: App.routes, dev: App.dev, build: App.build, deploy: App.deploy }
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const CreateApp = (options: CreateAppOptions): AppTargets => {
  const dirs: AppDirs = { ...defaultDirs, ...options.dirs }
  const cloudflare: Required<CloudflareDeploy> = { config: defaultWranglerConfig, ...options.deploy.cloudflare }
  const manifest: AppManifest = {
    name: options.name,
    brand: options.brand,
    nav: options.nav ?? [],
    dirs,
    deploy: { cloudflare }
  }

  // Everything the router reads. `routes` keys on this set, so adding a page,
  // a pane, a flow, or a layer file invalidates the generated tables and
  // nothing else does.
  const routed = S.glob([
    `${dirs.app}/**/page.tsx`,
    `${dirs.app}/layout.tsx`,
    `${dirs.app}/panes/*.tsx`,
    `${dirs.flows}/**/flow.ts`,
    `${dirs.flows}/**/flow.mdx`,
    "**/AGENT.ts",
    "**/SANDBOX.ts",
    "**/TOOLS.ts"
  ])
  const sources = S.glob([`${dirs.app}/**`, `${dirs.flows}/**`, `${dirs.tools}/**`, "worker/**", "src/**"])
  const wrangler = S.file(`//${cloudflare.config}`)

  // The generator is the package's own `smthrs-routes` bin, resolved from the
  // app's node_modules, so an app never names a path inside this package.
  const routes = S.Generate({
    bin: S.NodeModule.Bin("@smthrs/create-app", "smthrs-routes"),
    data: [routed, S.file("//PACKAGE.ts")],
    changes: ["routes.gen.ts", "routes.ui.gen.ts"]
  })

  const dev = S.Shell.Serve({
    bin: S.NodeModule.Bin("vite"),
    args: ["--port", String(devPort)],
    data: [sources, wrangler, S.file("//vite.config.ts"), routes],
    readiness: { port: devPort },
    stop: { signal: "SIGTERM", grace: "5s" },
    sandbox: { network: true }
  })

  const build = S.Shell.Build({
    bin: S.NodeModule.Bin("vite"),
    args: ["build"],
    data: [sources, wrangler, S.file("//vite.config.ts"), routes],
    outDirs: ["dist"]
  })

  // No `--config`: wrangler follows the vite plugin's
  // `.wrangler/deploy/config.json` redirect only when the flag is absent, and
  // that redirect points at the built Worker bundle. The source
  // `wrangler.jsonc` is the vite plugin's input, not wrangler's.
  const deploy = S.Shell.Run({
    bin: S.NodeModule.Bin("wrangler"),
    args: ["deploy"],
    gates: [build],
    secrets: [S.Secret("CLOUDFLARE_API_TOKEN"), S.Secret("CLOUDFLARE_ACCOUNT_ID")],
    sandbox: { network: true },
    approval: "required"
  })

  return { manifest, routes, dev, build, deploy }
}

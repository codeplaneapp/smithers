import { CreateApp } from "@smthrs/create-app"
import { Smithers as S } from "@smthrs/targets"
import { aomiBrand, aomiNav } from "./src/brand.ts"

// The whole app is declared here. `App` is the manifest plus the Cloudflare
// dev/build/deploy targets it derives; `Package` is the target map the
// `smthrs` CLI addresses as //:<name>. `App` is not a target, so exporting it
// beside `Package` is legal for the loader.
export const App = CreateApp({
  name: "aomi",
  brand: aomiBrand,
  nav: aomiNav,
  dirs: { app: "app", flows: "flows", tools: "tools" },
  deploy: {
    cloudflare: {
      workerName: "__APP_NAME__",
      // Replace with a hostname on a zone your Cloudflare account owns.
      domain: "__APP_NAME__.example.com",
      config: "worker/wrangler.jsonc"
    }
  }
})

const sources = S.glob(["app/**", "flows/**", "tools/**", "worker/**", "src/**"])
const srcs = S.Filegroup({ srcs: sources })

const typeCheck = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["--noEmit"],
  data: [sources, S.file("//tsconfig.json"), App.routes]
})

// Every flow's e2e test replays a recorded model fixture; SMTHRS_RECORD=1
// re-records against the live seat (network required).
const e2e = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run"],
  data: [sources, S.glob(["test/**", "flows/**/fixtures/**"]), App.routes],
  sandbox: { network: true }
})

export const Package = S.Package({
  targets: {
    srcs,
    routes: App.routes,
    dev: App.dev,
    build: App.build,
    deploy: App.deploy,
    typeCheck,
    e2e,
    check: S.Suite({ tests: [typeCheck, e2e] }),
    default: S.Alias(App.dev)
  }
})

import { CreateApp } from "@smthrs/create-app"
import { Smithers as S } from "@smthrs/targets"

// The whole app is declared here. `App` is the manifest plus the Cloudflare
// dev/build/deploy targets derived from it; `Package` is the target map the
// `smthrs` CLI addresses as //:<name>. `App` is not a target, so exporting it
// beside `Package` is legal for the loader.
export const App = CreateApp({
  name: "__APP_NAME__",
  brand: {
    name: "__APP_NAME__",
    theme: "system",
    fonts: {
      body: "'Inter', system-ui, sans-serif",
      mono: "'JetBrains Mono', ui-monospace, monospace",
      googleFonts: ["Inter:wght@400;500;600", "JetBrains+Mono:wght@400"]
    },
    tokens: {
      accent: "#5288c2",
      accentForeground: "#ffffff",
      background: "#ffffff",
      surface: "#f6f7f9",
      border: "#e4e4e7",
      foreground: "#09090b",
      foregroundMuted: "#52525b",
      radiusMd: "0.5rem",
      radiusLg: "0.75rem"
    }
  },
  nav: [{ label: "App", items: [{ label: "Chat", href: "/", icon: "message-square" }] }],
  dirs: { app: "app", flows: "flows", tools: "tools" },
  deploy: {
    cloudflare: {
      workerName: "__APP_NAME__",
      // Replace with a hostname on a zone your Cloudflare account owns.
      // Wrangler creates the DNS record and the certificate on first deploy.
      domain: "__APP_NAME__.example.com",
      config: "worker/wrangler.jsonc"
    }
  }
})

const sources = S.glob(["app/**", "flows/**", "tools/**", "worker/**", "src/**"])

const typeCheck = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["--noEmit"],
  data: [sources, S.file("//tsconfig.json"), App.routes]
})

export const Package = S.Package({
  targets: {
    srcs: S.Filegroup({ srcs: sources }),
    routes: App.routes,
    dev: App.dev,
    build: App.build,
    deploy: App.deploy,
    typeCheck,
    check: S.Suite({ tests: [typeCheck] }),
    default: S.Alias(App.dev)
  }
})

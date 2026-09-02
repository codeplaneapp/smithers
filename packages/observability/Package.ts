/** Documentation surfaces owned by `@smthrs/observability`. */
export const Package = {
  name: "@smthrs/observability",
  readme: {
    source: "docs/README.md",
    target: "packages/observability/README.md"
  },
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/observability.md"
  },
  subpaths: [
    {
      namespace: "BrowserOtel",
      source: "src/BrowserOtel.ts",
      specifier: "@smthrs/observability/BrowserOtel",
      platform: "browser"
    },
    {
      namespace: "NodeOtel",
      source: "src/NodeOtel.ts",
      specifier: "@smthrs/observability/NodeOtel",
      platform: "Node"
    }
  ],
  references: [
    "docs/pages/telemetry.md",
    "docs/pages/observability.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const

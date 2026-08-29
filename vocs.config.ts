import { defineConfig } from "vocs/config"

export default defineConfig({
  title: "Smithers Flows",
  description:
    "Smithers Flows is an Effect-based durable-execution engine: typed flows that replay from a journal, content-addressed action results, capability-checked host access, read-only sync, and time travel over run history.",
  srcDir: "docs",
  outDir: "docs/dist",
  sidebar: [
    { text: "Introduction", link: "/" },
    { text: "Architecture", link: "/architecture" },
    { text: "Data structures", link: "/data-structures" },
    { text: "Package structure", link: "/package-structure" },
    {
      text: "Examples",
      items: [
        { text: "Real-world workflows", link: "/examples/real-world" },
        { text: "Runnable example catalog", link: "/examples" }
      ]
    },
    {
      text: "Public API",
      items: [
        { text: "@smthrs/flows", link: "/api/flows" },
        { text: "@smthrs/jj", link: "/api/jj" },
        { text: "@smthrs/sandbox", link: "/api/sandbox" },
        { text: "@smthrs/platform-browser", link: "/api/platform-browser" },
        { text: "@smthrs/platform-node", link: "/api/platform-node" },
        { text: "@smthrs/platform-bun", link: "/api/platform-bun" },
        { text: "@smthrs/journal", link: "/api/journal" },
        { text: "@smthrs/run-store", link: "/api/run-store" },
        { text: "@smthrs/step-cache", link: "/api/step-cache" },
        { text: "@smthrs/artifacts", link: "/api/artifacts" },
        { text: "@smthrs/database", link: "/api/database" },
        { text: "@smthrs/capability", link: "/api/capability" },
        { text: "@smthrs/kernel", link: "/api/kernel" },
        { text: "@smthrs/canonical", link: "/api/canonical" },
        { text: "@smthrs/crypto", link: "/api/crypto" },
        { text: "@smthrs/keys", link: "/api/keys" },
        { text: "@smthrs/plan", link: "/api/plan" },
        { text: "@smthrs/flow", link: "/api/flow" },
        { text: "@smthrs/engine", link: "/api/engine" },
        { text: "@smthrs/engine-store", link: "/api/engine-store" },
        { text: "@smthrs/sync", link: "/api/sync" },
        { text: "@smthrs/time-travel", link: "/api/time-travel" },
        { text: "@smthrs/observability", link: "/api/observability" }
      ]
    },
    { text: "Internal details", link: "/internals" },
    { text: "Public API tests", link: "/api-tests" },
    { text: "Observability", link: "/observability" },
    { text: "Checkpoints and compaction", link: "/compaction" },
    { text: "Artifact GC", link: "/artifact-gc" },
    { text: "Probabilistic Selection", link: "/selection" },
    { text: "Disaster recovery", link: "/disaster-recovery" },
    { text: "SQLite operating envelope", link: "/sqlite-operating-envelope" },
    { text: "Telemetry", link: "/telemetry" },
    { text: "Design decisions", link: "/design-decisions" },
    { text: "Comparisons", link: "/comparisons" },
    { text: "External", link: "/external" },
    { text: "Contributor plan", link: "/contributing" },
    { text: "Code design", link: "/code-design" }
  ],
  topNav: [
    { text: "GitHub", link: "https://github.com/smithersai/flows" }
  ],
  socials: [
    { icon: "github", link: "https://github.com/smithersai/flows" }
  ]
})

import { defineConfig } from "vocs/config"

/**
 * The Smithers documentation site.
 *
 * `docs/pages` is the whole site and the repository's `public/` is served at its
 * root, which is where vocs resolves static assets from. The
 * CLI, control, release, changelog-index, and route-plan sections are generated
 * by `scripts/generate-docs-pages.mjs`; the sidebar below names them once so a
 * new command or RPC needs no edit here.
 */
export default defineConfig({
  title: "Smithers",
  description:
    "Smithers is an Effect-based durable-execution engine: typed flows that replay from a journal, content-addressed action results, capability-checked host access, read-only sync, and time travel over run history.",
  srcDir: "docs",
  outDir: "docs/dist",
  // The deploy target is a static host, so the build must emit HTML per route
  // rather than the SSR server bundle vocs produces by default. Under the
  // default `dynamic` strategy `docs/dist` holds `serve-node.js` and no
  // `index.html`, and uploading it to Pages publishes a directory listing.
  renderStrategy: "full-static",
  // `check-docs` is this site's dead-link gate: it reads the same three link
  // spellings vocs reads, and it also knows the one route that is linked before
  // the page answering it exists, which vocs has no way to record. vocs still
  // logs each dead link it finds, so nothing is hidden; it just does not fail
  // the build twice over on a rule the gate before it already applied.
  checkDeadlinks: "warn",
  sidebar: [
    { text: "Introduction", link: "/" },
    { text: "Installation", link: "/installation" },
    {
      text: "Guides",
      items: [
        { text: "Writing a flow", link: "/guides/writing-a-flow" },
        { text: "Running a flow", link: "/guides/running-flows" },
        { text: "Getting started in memory", link: "/guides/getting-started" },
        { text: "The durable engine", link: "/guides/durable-engine" },
        { text: "Host composition", link: "/guides/host-composition" },
        { text: "Testing", link: "/guides/testing" },
        { text: "Control-plane trust", link: "/guides/control-plane-trust" }
      ]
    },
    {
      text: "Concepts",
      items: [
        { text: "Durable execution model", link: "/concepts/durable-execution-model" },
        { text: "Actions", link: "/concepts/actions" },
        { text: "Step keys", link: "/concepts/step-keys" },
        { text: "Determinism and replay", link: "/concepts/determinism-and-replay" },
        { text: "Durable waits and control", link: "/concepts/durable-waits" },
        { text: "Failure and retry", link: "/concepts/failure-and-retry" },
        { text: "Child flows", link: "/concepts/subflows" },
        { text: "Concurrency", link: "/concepts/concurrency" },
        { text: "The action graph", link: "/concepts/action-graph" },
        { text: "Journal", link: "/concepts/journal" },
        { text: "Hosts and capabilities", link: "/concepts/hosts-and-capabilities" },
        { text: "Sync", link: "/concepts/sync" },
        { text: "Time travel", link: "/concepts/time-travel" },
        { text: "Effect integration", link: "/concepts/effect-integration" }
      ]
    },
    {
      text: "Command line",
      items: [
        { text: "Overview", link: "/cli" },
        { text: "plan", link: "/cli/plan" },
        { text: "run", link: "/cli/run" },
        { text: "up", link: "/cli/up" },
        { text: "approve", link: "/cli/approve" },
        { text: "deny", link: "/cli/deny" },
        { text: "cancel", link: "/cli/cancel" },
        { text: "down", link: "/cli/down" },
        { text: "signal", link: "/cli/signal" },
        { text: "steer", link: "/cli/steer" },
        { text: "ls", link: "/cli/ls" },
        { text: "ps", link: "/cli/ps" },
        { text: "status", link: "/cli/status" },
        { text: "logs", link: "/cli/logs" },
        { text: "output", link: "/cli/output" },
        { text: "memory", link: "/cli/memory" },
        { text: "serve", link: "/cli/serve" },
        { text: "gc", link: "/cli/gc" },
        { text: "init", link: "/cli/init" },
        { text: "doctor", link: "/cli/doctor" },
        { text: "docs", link: "/cli/docs" },
        { text: "skills", link: "/cli/skills" },
        { text: "mcp", link: "/cli/mcp" },
        { text: "claude", link: "/cli/claude" },
        { text: "update", link: "/cli/update" },
        { text: "bug", link: "/cli/bug" },
        { text: "migrate", link: "/cli/migrate" }
      ]
    },
    {
      text: "Control plane",
      items: [
        { text: "Overview", link: "/control" },
        { text: "Plan", link: "/control/plan" },
        { text: "Run", link: "/control/run" },
        { text: "Approve", link: "/control/approve" },
        { text: "Deny", link: "/control/deny" },
        { text: "Cancel", link: "/control/cancel" },
        { text: "Signal", link: "/control/signal" },
        { text: "Steer", link: "/control/steer" },
        { text: "Resume", link: "/control/resume" },
        { text: "List", link: "/control/list" },
        { text: "Watch", link: "/control/watch" }
      ]
    },
    {
      text: "Operations",
      items: [
        { text: "Databases", link: "/databases" },
        { text: "SQLite operating envelope", link: "/sqlite-operating-envelope" },
        { text: "Checkpoints and compaction", link: "/compaction" },
        { text: "Artifact GC", link: "/artifact-gc" },
        { text: "Disaster recovery", link: "/disaster-recovery" },
        { text: "Observability", link: "/observability" },
        { text: "Telemetry", link: "/telemetry" },
        { text: "Model registry", link: "/reference/sota-models" },
        { text: "Error codes", link: "/reference/errors" }
      ]
    },
    {
      text: "Release",
      items: [
        { text: "rc.0 support matrix", link: "/release/support-matrix" },
        { text: "Known limitations", link: "/release/known-limitations" },
        { text: "Compatibility policy", link: "/changelogs/compatibility-policy" },
        { text: "Changelogs", link: "/changelogs" },
        { text: "Route plan", link: "/routes" }
      ]
    },
    {
      text: "Migrating from 0.x",
      items: [
        { text: "The migration", link: "/migration/1.0" },
        { text: "@smthrs/migrate", link: "/migration/migrate-tool" }
      ]
    },
    {
      text: "Packages",
      items: [
        { text: "Package selection", link: "/package-structure" },
        { text: "@smthrs/flows", link: "/api/flows" },
        { text: "@smthrs/flow", link: "/api/flow" },
        { text: "@smthrs/engine", link: "/api/engine" },
        { text: "@smthrs/engine-store", link: "/api/engine-store" },
        { text: "@smthrs/control", link: "/api/control" },
        { text: "@smthrs/gateway", link: "/api/gateway" },
        { text: "@smthrs/agent", link: "/api/agent" },
        { text: "@smthrs/integrations", link: "/api/integrations" },
        {
          text: "@smthrs/patterns",
          link: "/api/patterns",
          items: [
            { text: "Loops", link: "/api/patterns-loops" },
            { text: "Delegation", link: "/api/patterns-delegation" },
            { text: "Teams", link: "/api/patterns-teams" }
          ]
        },
        { text: "@smthrs/registry", link: "/api/registry" },
        { text: "@smthrs/memory", link: "/api/memory" },
        { text: "@smthrs/notifications", link: "/api/notifications" },
        { text: "@smthrs/journal", link: "/api/journal" },
        { text: "@smthrs/run-store", link: "/api/run-store" },
        { text: "@smthrs/step-cache", link: "/api/step-cache" },
        { text: "@smthrs/plan", link: "/api/plan" },
        { text: "@smthrs/core", link: "/api/core" },
        { text: "@smthrs/artifacts", link: "/api/artifacts" },
        { text: "@smthrs/database", link: "/api/database" },
        { text: "@smthrs/capability", link: "/api/capability" },
        { text: "@smthrs/kernel", link: "/api/kernel" },
        { text: "@smthrs/keys", link: "/api/keys" },
        { text: "@smthrs/canonical", link: "/api/canonical" },
        { text: "@smthrs/crypto", link: "/api/crypto" },
        { text: "@smthrs/jj", link: "/api/jj" },
        { text: "@smthrs/sandbox", link: "/api/sandbox" },
        { text: "@smthrs/sync", link: "/api/sync" },
        { text: "@smthrs/time-travel", link: "/api/time-travel" },
        { text: "@smthrs/observability", link: "/api/observability" },
        { text: "@smthrs/platform-node", link: "/api/platform-node" },
        { text: "@smthrs/platform-bun", link: "/api/platform-bun" },
        { text: "@smthrs/platform-browser", link: "/api/platform-browser" }
      ]
    },
    {
      text: "Architecture",
      items: [
        { text: "Overview", link: "/architecture" },
        { text: "Package map", link: "/architecture/package-map" },
        { text: "Execution and data flow", link: "/architecture/execution-data-flow" },
        { text: "Browser support", link: "/architecture/browser-support" },
        { text: "Data structures", link: "/data-structures" },
        { text: "Design decisions", link: "/design-decisions" },
        { text: "Internal details", link: "/internals" },
        { text: "Code design", link: "/code-design" },
        { text: "Probabilistic selection", link: "/selection" },
        { text: "Comparisons", link: "/comparisons" },
        { text: "External surface", link: "/external" }
      ]
    },
    {
      text: "Examples",
      items: [
        { text: "Runnable catalog", link: "/examples" },
        { text: "Real-world flows", link: "/examples/real-world" },
        { text: "Public API tests", link: "/api-tests" }
      ]
    },
    { text: "Contributing", link: "/contributing" }
  ],
  topNav: [
    { text: "GitHub", link: "https://github.com/smithersai/smithers" }
  ],
  socials: [
    { icon: "github", link: "https://github.com/smithersai/smithers" }
  ]
})

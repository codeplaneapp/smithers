/**
 * Documentation surfaces owned by `@smthrs/patterns`.
 *
 * The package generator consumes this declaration. Four API pages are written
 * whole from package JSDoc plus `docs/`; the Public API fragment is projected
 * into the README so every published sentence has one package-owned source.
 */
export const DocsManifest = {
  name: "@smthrs/patterns",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/patterns.md",
    description: "@smthrs/patterns: higher-order flow patterns and the decorators that compose them.",
    title: "`@smthrs/patterns`"
  },
  pages: [
    {
      source: "docs/loops.md",
      target: "docs/pages/api/patterns-loops.md",
      description: "The loop-shaped patterns: review loops, recursion with fuel, and bounded iteration.",
      title: "Bounded loops in `@smthrs/patterns`"
    },
    {
      source: "docs/teams.md",
      target: "docs/pages/api/patterns-teams.md",
      description:
        "The six patterns that coordinate several agents as a team: Supervisor, Intervene, CheckSuite, Kanban, Runbook, and MergeQueue.",
      title: "Team topologies in `@smthrs/patterns`"
    },
    {
      source: "docs/delegation.md",
      target: "docs/pages/api/patterns-delegation.md",
      description: "The two delegation patterns: handing work to a sub-agent and routing it to the right one.",
      title: "Delegation patterns"
    }
  ],
  snippets: [{ source: "docs/surface.md", region: "patterns-surface", target: "README.md" }],
  references: []
} as const

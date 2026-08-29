import { expect, test } from "bun:test"
import { computeAffected } from "./Affected"

test("affected matches declared inputs and propagates through reverse dependencies", () => {
  const result = computeAffected({
    repoId: "repo", base: "abc", changedFiles: ["src/App.tsx", "README.md"],
    nodes: [
      { label: "//src:srcs", package: "//src", name: "srcs", rule: "Filegroup", kinds: [], private: false },
      { label: "//src:test", package: "//src", name: "test", rule: "Shell.Test", kinds: ["test"], private: false },
      { label: "//:docs", package: "//", name: "docs", rule: "Docs", kinds: ["docs"], private: false, plan: { inputs: ["README.md"] } }
    ],
    edges: [{ from: "//src:test", to: "//src:srcs", kind: "data" }],
    declarations: new Map([["//src:srcs", [{ pattern: "src/**", source: "declaration" as const }]]])
  })
  expect(result.affected).toEqual([
    { label: "//:docs", reason: "declared input: README.md" },
    { label: "//src:srcs", reason: "declared input: src/App.tsx" },
    { label: "//src:test", reason: "transitive via //src:srcs" }
  ])
  expect(result.signal).toContain("reverse graph")
})

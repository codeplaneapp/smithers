/** Public engineering inputs only. Full files invalidate/are archived even when
 * review uses curated excerpts. Ranges are original inclusive line numbers. */
import type { PageSpec } from "../../flows/wiki/schema.ts"
type Input = string | readonly [string, ...readonly (readonly [number, number])[]]
const page = (spec: Omit<PageSpec, "inputs" | "excerpts">, inputs: readonly Input[]): PageSpec => ({
  ...spec, inputs: inputs.map((input) => typeof input === "string" ? input : input[0]),
  excerpts: Object.fromEntries(inputs.filter((input): input is Exclude<Input, string> => typeof input !== "string").map(([path, ...ranges]) => [path, ranges.map(([start, end]) => ({ start, end }))]))
})
const runtime: Input = ["packages/smithers/flows/src/Runtime.ts", [150, 223]]
const operations: Input = ["flows/wiki/operations.ts", [36, 177]]
const ui = "apps/ui/AGENTS.md"
const flowDocs = "packages/smithers/flows/flow/docs/README.md"
const agentDocs = "packages/smithers/agent/docs/README.md"
const bun = "packages/smithers/flows/src/BunRuntime.ts"
const node = "packages/smithers/flows/src/NodeRuntime.ts"

export const pages: readonly PageSpec[] = [
  page({ id: "start-here", title: "Start here", purpose: "Find the owning layer and follow work through Smithers.", kind: "current", document: "factory/wiki/pages/start-here.md", related: ["flows", "runtime", "build-graph", "product-ui"] }, [
    flowDocs, runtime, agentDocs, "packages/smithers/build/targets/docs/README.md", ui, bun, node,
    ["packages/smithers/agent/src/AgentAction.ts", [253, 302], [390, 430]],
    ["flows/wiki/operations.ts", [94, 139]]
  ]),
  page({ id: "flows", title: "Flows, actions and replay", purpose: "Declare a typed capability once and attach its Effect implementation.", kind: "current", document: "factory/wiki/pages/flows.md", related: ["runtime", "agent", "build-graph"] }, [
    flowDocs, ["packages/smithers/flows/flow/src/Action/Action.ts", [109, 241]],
    ["packages/smithers/flows/flow/src/Flow/make.ts", [55, 191], [257, 291]],
    "factory/wiki/pages/build-graph.md", "packages/smithers/flows/docs/concepts/runtime-portability.md", "flows/wiki/PACKAGE.ts"
  ]),
  page({ id: "runtime", title: "Runtime portability and ownership", purpose: "Run the same durable program on Bun or Node through injected platform services.", kind: "current", document: "packages/smithers/flows/docs/concepts/runtime-portability.md", related: ["flows", "storage", "wiki-generation"] }, [
    runtime, bun, node, ["packages/smithers/flows/src/internal/NativeRuntime.ts", [63, 101], [333, 447]],
    "packages/smithers/flows/test/NativeRuntimeParity.test.ts", "packages/smithers/flows/test/fixtures/native-runtime.ts",
    ["packages/smithers/flows/test/NodeRuntime.test.ts", [783, 835], [871, 889], [1026, 1073], [1167, 1210]],
    "packages/smithers/flows/database/src/node/NodeDatabase.ts", "packages/smithers/flows/database/src/bun/BunDatabase.ts",
    ["packages/smithers/flows/database/src/internal/SqliteOpen.ts", [65, 123], [132, 208], [291, 343]],
    ["packages/smithers/flows/database/src/DurableWriter.ts", [64, 106], [208, 310]]
  ]),
  page({ id: "storage", title: "Journal and durable stores", purpose: "Use existing persisted execution facts instead of another coding ledger.", kind: "current", document: "factory/wiki/pages/storage.md", related: ["runtime", "flows", "wiki-generation"] }, [
    runtime, bun, node, "packages/smithers/flows/journal/docs/README.md", "packages/smithers/flows/run-store/docs/README.md",
    ["packages/smithers/flows/database/src/DurableWriter.ts", [64, 106], [208, 310]],
    ["packages/smithers/flows/flow/src/Action/Action.ts", [109, 241]], ["flows/wiki/operations.ts", [94, 145]]
  ]),
  page({ id: "build-graph", title: "Dependency-bound build targets", purpose: "Declare the exact code and documentation inputs that invalidate an output.", kind: "current", document: "factory/wiki/pages/build-graph.md", related: ["wiki-generation", "flows", "runtime"] }, [
    "packages/smithers/build/targets/docs/reference/filegroup.md", ["packages/smithers/build/targets/src/Filegroup.ts", [25, 91], [185, 283]],
    ["packages/smithers/build/targets/src/Shell.ts", [25, 115], [265, 350]], ".smithers/WORKSPACE.ts", "flows/wiki/PACKAGE.ts",
    "factory/wiki/catalog.ts", "flows/wiki/workflow.ts", operations, "flows/wiki/main.ts"
  ]),
  page({ id: "agent", title: "Agents are flow callers", purpose: "Understand cells, schema-bound model output and host-owned model seats.", kind: "current", document: "factory/wiki/pages/agent.md", related: ["flows", "wiki-generation", "product-ui"] }, [
    agentDocs, ["packages/smithers/agent/src/AgentAction.ts", [94, 149], [253, 302], [390, 430], [644, 774]],
    "flows/wiki/workflow.ts", "flows/wiki/runtime.ts", "flows/wiki/evidence.ts", operations, "apps/ui/docs/workbench-lanes/runs.md"
  ]),
  page({ id: "product-ui", title: "Embedded UI and recursive inspection", purpose: "Follow the existing frame, card and dispatcher boundaries.", kind: "current", document: "factory/wiki/pages/product-ui.md", related: ["agent", "storage", "coding-direction"] }, [
    ui, ["apps/ui/src/mainview/cards/RunTrace.ts", [20, 108], [175, 221], [510, 576]],
    ["apps/ui/src/mainview/cards/RunTraceCard.tsx", [66, 240]], "apps/ui/src/mainview/runtime/FrameHistory.ts",
    "apps/ui/docs/workbench-lanes/runs.md", ["flows/wiki/operations.ts", [94, 145]]
  ]),
  page({ id: "wiki-generation", title: "How this wiki stays accountable", purpose: "Separate source freshness, semantic review and human intent.", kind: "current", document: "factory/wiki/pages/wiki-generation.md", related: ["build-graph", "runtime", "coding-direction"] }, [
    "flows/wiki/schema.ts", "flows/wiki/workflow.ts", "flows/wiki/evidence.ts", "flows/wiki/operations.ts", "flows/wiki/runtime.ts", "flows/wiki/PACKAGE.ts", "flows/wiki/main.ts"
  ]),
  page({ id: "coding-direction", title: "Mythical coding product contract", purpose: "Read the intended lifecycle without confusing it with shipped behavior.", kind: "intent", document: "factory/wiki/pages/coding-direction.md", related: ["product-ui", "wiki-generation", "runtime"] }, [
    "packages/smithers/flows/docs/concepts/runtime-portability.md", ui
  ])
]
export const sourceFiles = [...new Set(pages.flatMap((page) => [page.document, ...page.inputs]))].sort()

import { expect, test } from "bun:test";
import * as smithers from "smithers-orchestrator";

// Guards the programmatic run-control + output-reading API on the public barrel.
// These power embedders that drive durable runs across processes (start a run,
// pause at an <Approval> gate, approve/deny, resume, and read node outputs)
// without reaching into internal @smithers-orchestrator/* subpackages.
test("public barrel exposes the programmatic run-control + output API", () => {
  const surface = smithers as unknown as Record<string, unknown>;
  for (const name of [
    "runWorkflow",
    "approveNode",
    "denyNode",
    "getRun",
    "listRuns",
    "signalRun",
    "loadOutputs",
    "loadOutputsEffect",
  ]) {
    expect(typeof surface[name]).toBe("function");
  }
});

test("documented smithers-orchestrator subpaths resolve", async () => {
  const documentedSubpaths: string[] = [
    "smithers-orchestrator/control-plane",
    "smithers-orchestrator/dom/renderer",
    "smithers-orchestrator/gateway",
    "smithers-orchestrator/gateway-client",
    "smithers-orchestrator/gateway-react",
    "smithers-orchestrator/gateway-ui",
    "smithers-orchestrator/jsx-dev-runtime",
    "smithers-orchestrator/jsx-runtime",
    "smithers-orchestrator/mdx-plugin",
    "smithers-orchestrator/memory",
    "smithers-orchestrator/observability",
    "smithers-orchestrator/openapi",
    "smithers-orchestrator/sandbox",
    "smithers-orchestrator/scorers",
    "smithers-orchestrator/serve",
    "smithers-orchestrator/server",
    "smithers-orchestrator/tools",
  ];
  for (const specifier of documentedSubpaths) {
    const mod = await import(specifier);
    expect(Object.keys(mod), specifier).not.toHaveLength(0);
  }
});

import { describe, expect, test } from "bun:test";
import {
  createSmithersAgentContract,
  renderSmithersAgentPromptGuidance,
} from "@smithers-orchestrator/agents/agent-contract";
import { buildSmithersPiSystemPrompt } from "../src/buildSmithersPiSystemPrompt.js";

describe("buildSmithersPiSystemPrompt", () => {
  test("standalone extension export resolves from the package path", async () => {
    const mod = await import("@smithers-orchestrator/pi-plugin/extension");

    expect(typeof mod.extension).toBe("function");
  });

  test("PI prompt stays in sync with the generated contract guidance", () => {
    const contract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: [
        {
          name: "list_runs",
          description: "List recent Smithers runs with stable structured summaries.",
        },
        {
          name: "get_run",
          description: "Get enriched structured state for a specific run.",
        },
        {
          name: "resolve_approval",
          description: "Destructive: approve or deny a pending approval.",
        },
      ],
    });

    const prompt = buildSmithersPiSystemPrompt("Base system prompt\n", "Docs body", contract);

    expect(prompt).toContain(renderSmithersAgentPromptGuidance(contract, {
      toolNamePrefix: "smithers_",
    }));
    expect(prompt).toContain("`smithers_list_runs`");
    expect(prompt).toContain("`smithers_get_run`");
    expect(prompt).toContain("`smithers_resolve_approval`");
    expect(prompt).not.toContain("`smithers_run_workflow`");
  });

  test("stale Smithers PI aliases are absent", () => {
    const contract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: [
        {
          name: "list_workflows",
          description: "List discovered local Smithers workflows.",
        },
        {
          name: "run_workflow",
          description: "Start a discovered workflow directly through the engine.",
        },
        {
          name: "list_runs",
          description: "List recent Smithers runs with stable structured summaries.",
        },
      ],
    });
    const prompt = buildSmithersPiSystemPrompt("Base system prompt\n", "Docs body", contract);
    const staleAliases = [
      /`smithers_run`/,
      /`smithers_status`/,
      /`smithers_list`/,
      /`smithers_resume`/,
      /`smithers_graph`/,
      /`smithers_frames`/,
    ];

    for (const pattern of staleAliases) {
      expect(contract.promptGuidance).not.toMatch(pattern);
      expect(prompt).not.toMatch(pattern);
    }
  });

  test("documents only registered Smithers PI CLI flags", () => {
    const contract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: [],
    });

    const prompt = buildSmithersPiSystemPrompt("Base system prompt\n", "Docs body", contract);

    expect(prompt).toContain("`--smithers-url`");
    expect(prompt).toContain("`--smithers-key`");
    expect(prompt).not.toContain("`-u`");
    expect(prompt).not.toContain("`-k`");
  });

  test("reports active approval nodes with non-canonical state strings", () => {
    const contract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: [],
    });

    const prompt = buildSmithersPiSystemPrompt("Base system prompt\n", "Docs body", contract, {
      runId: "run-approval",
      workflowName: "deploy",
      status: "running",
      nodeStates: [
        { nodeId: "node-waiting", state: "Waiting Approval" },
        { nodeId: "node-running", state: "running" },
      ],
      errors: [],
    });

    expect(prompt).toContain("Nodes waiting approval: node-waiting");
    expect(prompt).not.toContain("node-running");
  });
});

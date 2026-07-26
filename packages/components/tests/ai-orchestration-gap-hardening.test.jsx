/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Debate, DecisionTable, Optimizer, Panel, ReviewLoop, SuperSmithers, Task } from "../src/components/index.js";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";

const RUN_ID = "ai-orchestration-gaps";
const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };

async function render(element, outputs = {}) {
  const renderer = new SmithersRenderer();
  const ctx = new SmithersCtx({
    runId: RUN_ID,
    iteration: 0,
    input: {},
    outputs,
  });
  const graph = await renderer.render(<SmithersContext.Provider value={ctx}>{element}</SmithersContext.Provider>);
  return { graph, root: renderer.getRoot() };
}

function findHost(root, tag) {
  const visit = (node) => {
    if (!node || node.kind === "text") return undefined;
    if (node.tag === tag) return node;
    for (const child of node.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  const host = visit(root);
  expect(host).toBeDefined();
  return host;
}

function outputRow(nodeId, iteration, payload) {
  return { runId: RUN_ID, nodeId, iteration, ...payload };
}

describe("Panel duplicate panelist identities", () => {
  test("two panelists sharing a role each keep their own task, suffixed on collision", async () => {
    // Both panelists derive their task id from role "security". Without a
    // uniqueness guard the graph carries two `p-security` Task nodes, which
    // extraction rejects with DUPLICATE_ID (and the needs/deps maps collapse
    // to one entry), so neither panelist ever runs.
    const { graph } = await render(
      <Panel
        id="p"
        panelists={[
          { agent, role: "security" },
          { agent: otherAgent, role: "security" },
        ]}
        moderator={agent}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
      >
        review this
      </Panel>,
    );
    const first = graph.tasks.find((t) => t.nodeId === "p-security");
    const second = graph.tasks.find((t) => t.nodeId === "p-security-1");
    expect(first.agent).toBe(agent);
    expect(second.agent).toBe(otherAgent);
    // Both panelists still gate the moderator, and both feed its prompt.
    const moderator = graph.tasks.find((t) => t.nodeId === "p-moderator");
    expect(new Set(moderator.dependsOn)).toEqual(new Set(["p-security", "p-security-1"]));
    expect(moderator.prompt).toContain("### p-security\n");
    expect(moderator.prompt).toContain("### p-security-1\n");
  });

  test("a collision-suffixed id that is itself taken keeps searching for a free one", async () => {
    const { graph } = await render(
      <Panel
        id="p"
        panelists={[
          { agent, label: "sec" },
          { agent, label: "sec" },
          { agent: otherAgent, label: "sec-1" },
        ]}
        moderator={agent}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
      >
        review this
      </Panel>,
    );
    const ids = graph.tasks.map((t) => t.nodeId);
    expect(ids).toEqual(["p-sec", "p-sec-1", "p-sec-1-2", "p-moderator"]);
  });

  test("a panelist labeled moderator does not collide with the moderator task", async () => {
    const { graph } = await render(
      <Panel
        id="p"
        panelists={[{ agent, label: "moderator" }]}
        moderator={otherAgent}
        panelistOutput="panel_out"
        moderatorOutput="moderator_out"
      >
        review this
      </Panel>,
    );
    const moderator = graph.tasks.find((t) => t.nodeId === "p-moderator");
    expect(moderator.agent).toBe(otherAgent);
    expect(moderator.dependsOn).toEqual(["p-moderator-0"]);
  });
});

describe("ReviewLoop reviewer boundaries", () => {
  const baseProps = {
    producer: agent,
    produceOutput: "produce_out",
    reviewOutput: "review_out",
    children: "produce",
  };

  test("an empty reviewer array is rejected loudly instead of rendering an empty failover chain", () => {
    expect(() => ReviewLoop({ ...baseProps, reviewer: [] })).toThrow(/at least one reviewer/i);
  });

  test("a two-agent reviewer array stays a failover chain on the review task", () => {
    const el = ReviewLoop({ ...baseProps, reviewer: [agent, otherAgent] });
    const review = React.Children.toArray(el.props.children.props.children)[1];
    expect(review.props.agent).toEqual([agent, otherAgent]);
  });
});

describe("Debate rounds boundary", () => {
  test("rounds 0 reaches the loop verbatim: the default of 2 only fills in an omitted rounds", () => {
    const el = Debate({
      id: "d",
      proposer: agent,
      opponent: otherAgent,
      judge: agent,
      rounds: 0,
      argumentOutput: "argument_out",
      verdictOutput: "verdict_out",
      topic: "typed workflows",
    });
    const loop = React.Children.toArray(el.props.children)[0];
    expect(loop.props.maxIterations).toBe(0);
  });
});

describe("DecisionTable all-match boundaries", () => {
  test("all-match with no matching rule and no default renders nothing", async () => {
    const { graph } = await render(
      <DecisionTable
        strategy="all-match"
        rules={[
          {
            when: false,
            then: (
              <Task id="a" output="out">
                {{ ok: "a" }}
              </Task>
            ),
          },
        ]}
      />,
    );
    expect(graph.tasks).toHaveLength(0);
  });

  test("all-match filters rules by truthiness, not strict boolean equality", async () => {
    const { graph } = await render(
      <DecisionTable
        strategy="all-match"
        rules={[
          {
            when: 1,
            then: (
              <Task id="one" output="out">
                {{ ok: 1 }}
              </Task>
            ),
          },
          {
            when: 0,
            then: (
              <Task id="zero" output="out">
                {{ ok: 0 }}
              </Task>
            ),
          },
          {
            when: "yes",
            then: (
              <Task id="yes" output="out">
                {{ ok: "y" }}
              </Task>
            ),
          },
          {
            when: "",
            then: (
              <Task id="empty" output="out">
                {{ ok: "" }}
              </Task>
            ),
          },
          {
            when: null,
            then: (
              <Task id="nil" output="out">
                {{ ok: null }}
              </Task>
            ),
          },
        ]}
        default={
          <Task id="fallback" output="out">
            {{ ok: true }}
          </Task>
        }
      />,
    );
    expect(graph.tasks.map((t) => t.nodeId)).toEqual(["one", "yes"]);
  });
});

describe("SuperSmithers empty targetFiles boundary", () => {
  test("an empty targetFiles array falls back to 'All files in the project' like an omitted one", () => {
    const el = SuperSmithers({
      id: "ss",
      strategy: "Refactor",
      agent,
      targetFiles: [],
      dryRun: true,
      reportOutput: "report_out",
    });
    const read = React.Children.toArray(el.props.children)[0];
    expect(read.props.children).toContain("All files in the project");
    expect(read.props.children).not.toContain("Target Files\n\n\n");
  });
});

describe("Optimizer evaluation-row correlation", () => {
  const baseProps = {
    generator: agent,
    evaluator: otherAgent,
    generateOutput: "gen_out",
    evaluateOutput: "eval_out",
    targetScore: 0.9,
    children: "generate",
  };

  test("only the latest evaluation counts: an old converged score does not stick", async () => {
    const regressed = await render(<Optimizer {...baseProps} id="opt" />, {
      eval_out: [outputRow("opt-evaluate", 0, { score: 0.95 }), outputRow("opt-evaluate", 1, { score: 0.2 })],
    });
    expect(findHost(regressed.root, "smithers:ralph").rawProps.until).toBe(false);

    const improved = await render(<Optimizer {...baseProps} id="opt" />, {
      eval_out: [outputRow("opt-evaluate", 0, { score: 0.2 }), outputRow("opt-evaluate", 1, { score: 0.95 })],
    });
    expect(findHost(improved.root, "smithers:ralph").rawProps.until).toBe(true);
  });

  test("a converged score written by a different node never triggers convergence", async () => {
    const { root } = await render(<Optimizer {...baseProps} id="opt" />, {
      eval_out: [outputRow("someone-else", 0, { score: 0.99 })],
    });
    expect(findHost(root, "smithers:ralph").rawProps.until).toBe(false);
  });
});

describe("Optimizer compute-mode evaluator wiring", () => {
  test("a function evaluator renders a compute task gated on the generate task, not an agent task", async () => {
    const evaluator = () => ({ score: 1 });
    const { graph } = await render(
      <Optimizer id="opt" generator={agent} evaluator={evaluator} generateOutput="gen_out" evaluateOutput="eval_out">
        generate
      </Optimizer>,
    );
    const evaluate = graph.tasks.find((t) => t.nodeId === "opt-evaluate");
    expect(evaluate).toBeDefined();
    expect(evaluate.agent).toBeUndefined();
    expect(evaluate.computeFn).toBe(evaluator);
    expect(evaluate.outputTableName).toBe("eval_out");
    expect(evaluate.needs).toEqual({ candidate: "opt-generate" });
  });
});

/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import React from "react";
import { ForkFanOut, Task, Workflow } from "../src/components/index.js";
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
import { outputSchemas } from "./schema.js";

const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const lintAgent = { id: "lint-agent", generate: async () => ({ text: "ok" }) };

async function render(element) {
  const renderer = new SmithersRenderer();
  const graph = await renderer.render(element);
  return { graph, root: renderer.getRoot() };
}

/** Render a ForkFanOut alongside the source task it forks (fork validation requires it in-graph). */
function renderFanOut(props) {
  return render(
    <Workflow name="fanout">
      <Task id="implement" agent={agent} output={outputSchemas.outputC}>
        Implement the feature.
      </Task>
      <ForkFanOut {...props} />
    </Workflow>,
  );
}

function byId(res) {
  return new Map(res.tasks.map((task) => [task.nodeId, task]));
}

function findHosts(node, tag, found = []) {
  if (!node || node.kind === "text") return found;
  if (node.tag === tag) found.push(node);
  for (const child of node.children ?? []) findHosts(child, tag, found);
  return found;
}

const chores = [
  { id: "lint", prompt: "Run the linter and fix every finding." },
  { id: "commit", prompt: "Split the working copy into small named commits." },
  { id: "memory", prompt: "Record durable lessons to memory." },
];

describe("ForkFanOut", () => {
  test("every entry becomes an agent task forking the same source", async () => {
    const { graph } = await renderFanOut({
      id: "wrapup",
      fork: "implement",
      agent,
      taskOutput: outputSchemas.outputC,
      tasks: chores,
    });
    const tasks = byId(graph);
    for (const entry of chores) {
      const desc = tasks.get(`wrapup-${entry.id}`);
      expect(desc).toBeDefined();
      expect(desc.forkSource).toBe("implement");
      expect(desc.kind).toBe("agent");
      expect(desc.prompt).toBe(entry.prompt);
    }
    expect(tasks.get("wrapup-lint")?.parallelGroupId).toBeDefined();
  });

  test("shared preamble is prepended to every entry prompt", async () => {
    const { graph } = await renderFanOut({
      id: "wrapup",
      fork: "implement",
      agent,
      taskOutput: outputSchemas.outputC,
      tasks: chores,
      children: "The main work is done. Only do your own chore.",
    });
    const lint = byId(graph).get("wrapup-lint");
    expect(lint?.prompt).toContain("The main work is done. Only do your own chore.");
    expect(lint?.prompt).toContain("Run the linter and fix every finding.");
  });

  test("per-entry agent overrides the component-level agent", async () => {
    const { graph } = await renderFanOut({
      id: "wrapup",
      fork: "implement",
      agent,
      taskOutput: outputSchemas.outputC,
      tasks: [{ id: "lint", prompt: "Lint.", agent: lintAgent }],
    });
    expect(byId(graph).get("wrapup-lint")?.agent).toBe(lintAgent);
  });

  test("taskProps apply to every entry and per-entry options win", async () => {
    const { graph } = await renderFanOut({
      id: "wrapup",
      fork: "implement",
      agent,
      taskOutput: outputSchemas.outputC,
      taskProps: { continueOnFail: true, retries: 2 },
      tasks: [
        { id: "lint", prompt: "Lint." },
        { id: "commit", prompt: "Commit.", retries: 0 },
      ],
    });
    const tasks = byId(graph);
    expect(tasks.get("wrapup-lint")?.continueOnFail).toBe(true);
    expect(tasks.get("wrapup-lint")?.retries).toBe(2);
    expect(tasks.get("wrapup-commit")?.continueOnFail).toBe(true);
    expect(tasks.get("wrapup-commit")?.retries).toBe(0);
  });

  test("taskProps cannot replace generated-task invariants", async () => {
    const { graph } = await renderFanOut({
      id: "wrapup",
      fork: "implement",
      agent,
      taskOutput: outputSchemas.outputC,
      taskProps: { fork: "other", agent: lintAgent, continueOnFail: true },
      tasks: [{ id: "lint", prompt: "Lint." }],
    });
    const desc = byId(graph).get("wrapup-lint");
    expect(desc?.forkSource).toBe("implement");
    expect(desc?.agent).toBe(agent);
    expect(desc?.continueOnFail).toBe(true);
  });

  test("maxConcurrency and label land on the parallel group", async () => {
    const { root } = await renderFanOut({
      id: "wrapup",
      fork: "implement",
      agent,
      taskOutput: outputSchemas.outputC,
      tasks: chores,
      maxConcurrency: 2,
      label: "Wrap-up chores",
    });
    const parallel = findHosts(root, "smithers:parallel")[0];
    expect(parallel).toBeDefined();
    expect(parallel.rawProps.maxConcurrency).toBe(2);
    expect(parallel.rawProps.label).toBe("Wrap-up chores");
  });

  test("entry skipIf omits only that entry; component skipIf renders nothing", async () => {
    const { graph } = await renderFanOut({
      id: "wrapup",
      fork: "implement",
      agent,
      taskOutput: outputSchemas.outputC,
      tasks: [...chores.map((c) => ({ ...c, skipIf: c.id === "memory" }))],
    });
    const tasks = byId(graph);
    expect(tasks.get("wrapup-lint")).toBeDefined();
    expect(tasks.get("wrapup-commit")).toBeDefined();
    expect(tasks.get("wrapup-memory")).toBeUndefined();
    expect(ForkFanOut({ skipIf: true, fork: "implement", agent, tasks: chores })).toBeNull();
  });

  test("fails fast on duplicate ids, missing agent, missing output, empty tasks, and missing fork", () => {
    expect(() =>
      ForkFanOut({ fork: "implement", agent, taskOutput: outputSchemas.outputC, tasks: [chores[0], chores[0]] }),
    ).toThrow('duplicate id: "lint"');
    expect(() => ForkFanOut({ fork: "implement", taskOutput: outputSchemas.outputC, tasks: [chores[0]] })).toThrow(
      'ForkFanOut task "lint" has no agent',
    );
    expect(() => ForkFanOut({ fork: "implement", agent, tasks: [chores[0]] })).toThrow(
      'ForkFanOut task "lint" has no output',
    );
    expect(() => ForkFanOut({ fork: "implement", agent, taskOutput: outputSchemas.outputC, tasks: [] })).toThrow(
      "must include at least one task",
    );
    expect(() => ForkFanOut({ agent, taskOutput: outputSchemas.outputC, tasks: chores })).toThrow(
      "requires a fork source task id",
    );
  });
});

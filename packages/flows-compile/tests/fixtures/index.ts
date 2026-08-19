import { extractGraph } from "@smthrs/graph/extract";
import type { ExtractOptions, GraphSnapshot, HostNode } from "@smthrs/graph/types";

/**
 * Fixture workflows for the golden plan snapshots.
 *
 * They are host trees, which is what the React reconciler hands `extractGraph`
 * in production, and they go through the real `extractGraph` — the compiler is
 * therefore exercised against genuine `TaskDescriptor` values rather than
 * hand-written ones. The set mirrors the shapes `e2e/parity/fixtures` drives:
 * a linear chain, a fan-out and merge, an approval gate, side-effect tiers, and
 * a loop iteration.
 */

const el = (tag: string, rawProps: Record<string, unknown> = {}, children: HostNode[] = []): HostNode => {
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawProps)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      props[key] = String(value);
    }
  }
  // The reconciler hands `children` down as a raw prop as well as a host child,
  // and an agent task's prompt is read off the prop. Mirroring that here keeps
  // the fixtures the same shape the runtime produces.
  const prompt = children
    .filter((child): child is Extract<HostNode, { kind: "text" }> => child.kind === "text")
    .map((child) => child.text)
    .join("");
  const resolved = prompt === "" || "children" in rawProps ? rawProps : { ...rawProps, children: prompt };
  return { kind: "element", tag, props, rawProps: resolved, children };
};

const text = (value: string): HostNode => ({ kind: "text", text: value });

const agent = (id: string, tools: readonly string[] = []) => ({
  id,
  tools: Object.fromEntries(tools.map((tool) => [tool, {}])),
  generate: async () => ({}),
});

const options: ExtractOptions = {
  resolveWorktreePath: (path) => `/fixture-root/${path}`,
};

export type Fixture = {
  readonly id: string;
  readonly title: string;
  readonly root: HostNode;
  readonly extract?: ExtractOptions;
};

const linearSequence: Fixture = {
  id: "linear-sequence",
  title: "static seed, compute transform, agent write-up",
  root: el("smithers:workflow", {}, [
    el("smithers:task", {
      id: "seed",
      output: "seeds",
      __smithersKind: "static",
      __smithersPayload: { topic: "durable execution", limit: 3 },
    }),
    el("smithers:task", {
      id: "shape",
      output: "shapes",
      __smithersKind: "compute",
      __smithersComputeFn: () => ({ shaped: true }),
      needs: { seed: "seed" },
    }),
    el(
      "smithers:task",
      {
        id: "write",
        output: "writeups",
        __smithersKind: "agent",
        agent: agent("claude-code", ["Read", "Write"]),
        needs: { shape: "shape" },
        dependsOn: ["seed"],
        label: "Write the summary",
        retries: 2,
      },
      [text("Summarize the shaped rows.")],
    ),
  ]),
};

const parallelFanout: Fixture = {
  id: "parallel-fanout",
  title: "one seed, three concurrent agents, one merge",
  root: el("smithers:workflow", {}, [
    el("smithers:task", {
      id: "seed",
      output: "seeds",
      __smithersKind: "static",
      __smithersPayload: { candidates: ["a", "b", "c"] },
    }),
    el("smithers:parallel", { id: "fanout", maxConcurrency: 2 }, [
      el(
        "smithers:task",
        {
          id: "review-a",
          output: "reviews",
          __smithersKind: "agent",
          agent: agent("codex"),
          needs: { seed: "seed" },
        },
        [text("Review candidate a.")],
      ),
      el(
        "smithers:task",
        {
          id: "review-b",
          output: "reviews",
          __smithersKind: "agent",
          agent: agent("codex"),
          needs: { seed: "seed" },
        },
        [text("Review candidate b.")],
      ),
      el(
        "smithers:task",
        {
          id: "review-c",
          output: "reviews",
          __smithersKind: "agent",
          agent: agent("codex"),
          needs: { seed: "seed" },
        },
        [text("Review candidate c.")],
      ),
    ]),
    el("smithers:task", {
      id: "merge",
      output: "merged",
      __smithersKind: "compute",
      __smithersComputeFn: () => ({ merged: true }),
      needs: { a: "review-a", b: "review-b", c: "review-c" },
    }),
  ]),
};

const approvalGate: Fixture = {
  id: "approval-gate",
  title: "an agent proposal behind a human decision gate",
  root: el("smithers:workflow", {}, [
    el(
      "smithers:task",
      {
        id: "propose",
        output: "proposals",
        __smithersKind: "agent",
        agent: agent("claude-code"),
        continueOnFail: true,
      },
      [text("Propose a migration order.")],
    ),
    el("smithers:task", {
      id: "decide",
      output: "decisions",
      __smithersKind: "human",
      __smithersComputeFn: () => ({ decided: true }),
      needs: { proposal: "propose" },
      needsApproval: true,
      approvalMode: "decision",
      approvalOnDeny: "skip",
      approvalOptions: [
        { key: "ship", label: "Ship it" },
        { key: "hold", label: "Hold" },
      ],
      approvalAllowedScopes: ["run:approve"],
    }),
    el("smithers:task", {
      id: "record",
      output: "records",
      __smithersKind: "static",
      __smithersPayload: { recorded: true },
      dependsOn: ["decide"],
    }),
  ]),
};

const sideEffectTiers: Fixture = {
  id: "side-effect-tiers",
  title: "sealed, compensable, and irreversible tasks in one worktree",
  root: el("smithers:workflow", {}, [
    el("smithers:worktree", { id: "wt", path: "lanes/one", branch: "lane", baseBranch: "main" }, [
      el("smithers:task", { id: "plan", output: "plans", __smithersKind: "agent", agent: agent("claude-code") }, [
        text("Plan the change."),
      ]),
      el(
        "smithers:task",
        {
          id: "apply",
          output: "applies",
          __smithersKind: "agent",
          agent: agent("claude-code"),
          needs: { plan: "plan" },
          sideEffect: { idempotent: false, revert: async () => {} },
        },
        [text("Apply the change.")],
      ),
      el(
        "smithers:task",
        {
          id: "publish",
          output: "publishes",
          __smithersKind: "agent",
          agent: agent("claude-code"),
          needs: { apply: "apply" },
          sideEffect: { idempotent: true },
        },
        [text("Publish the change.")],
      ),
    ]),
  ]),
};

const loopIteration: Fixture = {
  id: "loop-iteration",
  title: "a loop body on its third iteration",
  extract: { ralphIterations: { improve: 2 } },
  root: el("smithers:workflow", {}, [
    el("smithers:ralph", { id: "improve", maxIterations: 5 }, [
      el("smithers:task", { id: "attempt", output: "attempts", __smithersKind: "agent", agent: agent("codex") }, [
        text("Improve the draft."),
      ]),
      el("smithers:task", {
        id: "score",
        output: "scores",
        __smithersKind: "compute",
        __smithersComputeFn: () => ({ score: 1 }),
        needs: { attempt: "attempt" },
      }),
    ]),
  ]),
};

export const fixtures: readonly Fixture[] = [
  linearSequence,
  parallelFanout,
  approvalGate,
  sideEffectTiers,
  loopIteration,
];

/** Runs a fixture through the real `extractGraph`, at a fixed run and frame. */
export const snapshotOf = (fixture: Fixture): GraphSnapshot => {
  const graph = extractGraph(fixture.root, { ...options, ...fixture.extract });
  return {
    runId: `fixture-${fixture.id}`,
    frameNo: 1,
    xml: graph.xml,
    tasks: graph.tasks,
  };
};

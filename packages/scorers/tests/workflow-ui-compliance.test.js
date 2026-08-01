import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  gradeWorkflowUiSource,
  workflowHasAgentTasks,
  workflowUiComplianceScorer,
} from "../src/workflowUiCompliance.js";

const COMPLIANT_UI = `/** @jsxImportSource react */
import { useState } from "react";
import { createGatewayReactRoot, useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { FleetTable, NodeChatStream, NodeStageStrip, RunMeta, WorkflowUiShell, nodeStatusIndex } from "smithers-orchestrator/gateway-ui";
import { EmptyState, KpiStat } from "smithers-orchestrator/ui";

function App() {
  const [selected, setSelected] = useState("a");
  return (
    <WorkflowUiShell title="Fleet" meta={<RunMeta runId="run-1" />}>
      <NodeStageStrip runId="run-1" stages={[{ nodeId: "plan" }]} />
      <FleetTable runId="run-1" items={[]} selectedKey={selected} onSelect={setSelected} />
      <NodeChatStream runId="run-1" nodeId={selected + ":implement"} />
    </WorkflowUiShell>
  );
}
createGatewayReactRoot(<App />);
`;

// The exact failure mode this grader exists to catch: hand-rolled pills with
// hex colors, a raw <table>, no shell, no live agent chat.
const HAND_ROLLED_UI = `/** @jsxImportSource react */
import { useState } from "react";
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";

function Pill({ status }) {
  return <span style={{ background: "#26262b", color: "#9a9aa5", borderRadius: 999 }}>{status}</span>;
}
function App() {
  return (
    <div style={{ fontFamily: "ui-sans-serif" }}>
      <WorkflowUiStyles />
      <table><tbody><tr><td><Pill status="pending" /></td></tr></tbody></table>
    </div>
  );
}
createGatewayReactRoot(<App />);
`;

// The silent-failure this rule exists to catch: a phase strip that rolls its
// own node statuses up against engine lifecycle words. `toRunStatus` has
// already mapped those to `ok`, so every finished phase renders as un-started.
const ENGINE_VOCABULARY_UI = `/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { NodeChatStream, RunMeta, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";

function statusOf(tree, ids) {
  const mine = ids.map((id) => (tree.nodes ?? []).find((n) => n.id === id)).filter(Boolean);
  if (mine.some((n) => n.status === "running")) return "running";
  if (mine.every((n) => n.status === "completed")) return "completed";
  if (mine.some((n) => n.status !== "finished")) return "partial";
  return "pending";
}
function App() {
  const tree = useGatewayRunTree("run-1");
  return (
    <WorkflowUiShell title="Phases" meta={<RunMeta runId="run-1" />}>
      <span>{statusOf(tree, ["plan"])}</span>
      <NodeChatStream runId="run-1" nodeId="plan" />
    </WorkflowUiShell>
  );
}
createGatewayReactRoot(<App />);
`;

// A ticket/agent-output `status` has its own vocabulary and must not be
// flagged, including in a UI that also reads the run tree.
const TICKET_STATUS_UI = `/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { RunMeta, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";

function App({ ticket }) {
  const tree = useGatewayRunTree("run-1");
  return (
    <WorkflowUiShell title="Tickets" meta={<RunMeta runId="run-1" />}>
      <span>{tree.status}</span>
      <span>{ticket.status === "pending" ? "queued" : "ready"}</span>
    </WorkflowUiShell>
  );
}
createGatewayReactRoot(<App />);
`;

const AGENT_WORKFLOW = `
export default function Workflow() {
  return (
    <Workflow>
      <Task id="implement" agent="opencode" prompt={"Implement the view."} />
      <Task id="gate" computeFn={runTypecheck} />
    </Workflow>
  );
}
`;

const DETERMINISTIC_WORKFLOW = `
export default function Workflow() {
  return (
    <Workflow>
      <Task id="gate" computeFn={runTypecheck} />
      <Task id="commit" computeFn={commit} staticPayload={{ ok: true }} />
    </Workflow>
  );
}
`;

const CHILD_PROMPT_WORKFLOW = `
<Workflow>
  <Task id="implement" agent={opencodeAgent}>Implement the view.</Task>
</Workflow>
`;

const DETERMINISTIC_CHILD_WORKFLOW = `
<Workflow>
  <Task id="gate" computeFn={runTypecheck}>This is only a deterministic child.</Task>
</Workflow>
`;

const CREATE_UI_SHAPED_WORKFLOW = `
function prompt(feedback) {
  return /['"]/.test(feedback) ? feedback : "";
}
return (
  <Workflow>
    <Task id="author-and-verify" agent={agents.smart}>
      {prompt(feedback)}
    </Task>
    <Task id="ui-compliance">{() => gradeUi()}</Task>
  </Workflow>
);
`;

describe("gradeWorkflowUiSource", () => {
  test("passes a UI composed from the shipped design system", () => {
    const report = gradeWorkflowUiSource(COMPLIANT_UI, { workflowSource: AGENT_WORKFLOW });
    expect(report.violations).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(1);
  });

  test("flags node statuses matched against engine lifecycle words", () => {
    const report = gradeWorkflowUiSource(ENGINE_VOCABULARY_UI, { workflowSource: AGENT_WORKFLOW });
    const violations = report.violations.filter((violation) => violation.rule === "node-status-vocabulary");
    expect(violations).toHaveLength(2);
    expect(violations[0].detail).toContain('"completed"');
    expect(violations[1].detail).toContain('"finished"');
    expect(report.passed).toBe(false);
  });

  test("accepts the tones the gateway actually emits", () => {
    const report = gradeWorkflowUiSource(
      ENGINE_VOCABULARY_UI.replaceAll('=== "completed"', '=== "ok"').replaceAll('!== "finished"', '!== "ok"'),
      { workflowSource: AGENT_WORKFLOW },
    );
    expect(report.violations.map((violation) => violation.rule)).not.toContain("node-status-vocabulary");
  });

  test("leaves a non-run-tree status vocabulary alone", () => {
    const report = gradeWorkflowUiSource(TICKET_STATUS_UI, { workflowSource: DETERMINISTIC_WORKFLOW });
    expect(report.violations.map((violation) => violation.rule)).not.toContain("node-status-vocabulary");
  });

  test("covers every authoritative engine TaskState", () => {
    const taskStates = [
      "pending",
      "waiting-approval",
      "waiting-event",
      "waiting-timer",
      "waiting-quota",
      "waiting-bound",
      "bound-stale",
      "in-progress",
      "finished",
      "failed",
      "cancelled",
      "skipped",
    ];
    const source = TICKET_STATUS_UI.replace(
      '  const tree = useGatewayRunTree("run-1");',
      `  const tree = useGatewayRunTree("run-1");\n${taskStates
        .map((state) => `  void (tree.status === ${JSON.stringify(state)});`)
        .join("\n")}`,
    );
    const violations = gradeWorkflowUiSource(source, {
      workflowSource: DETERMINISTIC_WORKFLOW,
    }).violations.filter((violation) => violation.rule === "node-status-vocabulary");

    expect(violations).toHaveLength(10);
    for (const state of taskStates.filter((state) => state !== "failed" && state !== "cancelled")) {
      expect(
        violations.some((violation) => violation.detail.includes(JSON.stringify(state))),
        state,
      ).toBe(true);
    }
  });

  test("ignores status comparisons shown as text", () => {
    const source = TICKET_STATUS_UI.replace(
      "function App({ ticket }) {",
      'const quotedExample = \'node.status === "finished"\';\nconst templateExample = `node.status === "completed"`;\nfunction App({ ticket }) {',
    ).replace(
      "      <span>{tree.status}</span>",
      "      <span>{tree.status}</span><pre>{quotedExample}{templateExample}</pre>",
    );
    const report = gradeWorkflowUiSource(source, { workflowSource: DETERMINISTIC_WORKFLOW });

    expect(report.violations.map((violation) => violation.rule)).not.toContain("node-status-vocabulary");
  });

  test("flags the classic hand-rolled dashboard", () => {
    const report = gradeWorkflowUiSource(HAND_ROLLED_UI, { workflowSource: AGENT_WORKFLOW });
    const rules = report.violations.map((violation) => violation.rule);
    expect(rules).toContain("shell");
    expect(rules).toContain("live-chat");
    expect(rules).toContain("hand-rolled-colors");
    expect(rules).toContain("hand-rolled-pills");
    expect(rules).toContain("hand-rolled-table");
    expect(report.passed).toBe(false);
    expect(report.score).toBeLessThan(0.5);
  });

  test("only requires NodeChatStream when the workflow runs agents", () => {
    const noChat = COMPLIANT_UI.replace(/\s*<NodeChatStream[^>]*\/>/, "");
    expect(gradeWorkflowUiSource(noChat, { workflowSource: DETERMINISTIC_WORKFLOW }).passed).toBe(true);
    expect(
      gradeWorkflowUiSource(noChat, { workflowSource: AGENT_WORKFLOW }).violations.map((violation) => violation.rule),
    ).toContain("live-chat");
    expect(
      gradeWorkflowUiSource(noChat, { requireNodeChat: true }).violations.map((violation) => violation.rule),
    ).toContain("live-chat");
  });

  test("rejects imports outside react + the smithers subpaths", () => {
    const report = gradeWorkflowUiSource(`import styled from "styled-components";\n${COMPLIANT_UI}`, {
      requireNodeChat: false,
    });
    expect(report.violations.map((violation) => violation.rule)).toContain("imports");
  });

  test("checks same-line import declarations", () => {
    const source = `${COMPLIANT_UI}; import styled from "styled-components";`;
    expect(
      gradeWorkflowUiSource(source, { requireNodeChat: false }).violations.map((violation) => violation.rule),
    ).toContain("imports");
  });

  test("rejects forbidden side-effect imports", () => {
    const source = `${COMPLIANT_UI}; import "styled-components";`;
    expect(
      gradeWorkflowUiSource(source, { requireNodeChat: false }).violations.map((violation) => violation.rule),
    ).toContain("imports");
  });

  test("accepts supported nested UI adapter imports", () => {
    const source = `${COMPLIANT_UI}
import { adapter } from "smithers-orchestrator/ui/adapters/compact";
import { otherAdapter } from "@smithers-orchestrator/ui/adapters/compact";
void adapter; void otherAdapter;
`;
    expect(
      gradeWorkflowUiSource(source, { requireNodeChat: false }).violations.map((violation) => violation.rule),
    ).not.toContain("imports");
  });

  test("requires rendered or called usage instead of imported names", () => {
    const unused = `
import { WorkflowUiShell, createGatewayReactRoot, NodeChatStream } from "smithers-orchestrator/ui";
const App = () => <div />;
`;
    const rules = gradeWorkflowUiSource(unused, { requireNodeChat: true }).violations.map(
      (violation) => violation.rule,
    );
    expect(rules).toEqual(expect.arrayContaining(["shell", "mount", "live-chat"]));
  });

  test("recognizes aliased rendered shell, chat, and mount usage", () => {
    const aliased = COMPLIANT_UI.replace("createGatewayReactRoot", "createGatewayReactRoot as mount")
      .replace("WorkflowUiShell", "WorkflowUiShell as Shell")
      .replace("NodeChatStream", "NodeChatStream as Chat")
      .replaceAll("<WorkflowUiShell", "<Shell")
      .replaceAll("</WorkflowUiShell>", "</Shell>")
      .replaceAll("<NodeChatStream", "<Chat")
      .replace("createGatewayReactRoot(<App />)", "mount(<App />)");
    expect(gradeWorkflowUiSource(aliased, { requireNodeChat: true }).passed).toBe(true);
  });

  test("resolves namespace bindings only when qualified names are used", () => {
    const valid = `import * as UI from "smithers-orchestrator/gateway-ui";
import * as Gateway from "smithers-orchestrator/gateway-react";
const App = () => <UI.WorkflowUiShell><UI.NodeChatStream /></UI.WorkflowUiShell>;
Gateway.createGatewayReactRoot(<App />);`;
    expect(gradeWorkflowUiSource(valid, { requireNodeChat: true }).passed).toBe(true);
    const unused = valid
      .replaceAll("UI.WorkflowUiShell", "Other.WorkflowUiShell")
      .replaceAll("UI.NodeChatStream", "Other.NodeChatStream")
      .replaceAll("Gateway.createGatewayReactRoot", "Other.createGatewayReactRoot");
    expect(
      gradeWorkflowUiSource(unused, { requireNodeChat: true }).violations.map((violation) => violation.rule),
    ).toEqual(expect.arrayContaining(["shell", "mount", "live-chat"]));
  });

  test("does not accept original names when aliased imports are unused", () => {
    const source = `import { WorkflowUiShell as Shell, createGatewayReactRoot as mount, NodeChatStream as Chat } from "smithers-orchestrator/gateway-ui";
const App = () => <div>WorkflowUiShell NodeChatStream createGatewayReactRoot</div>;`;
    expect(
      gradeWorkflowUiSource(source, { requireNodeChat: true }).violations.map((violation) => violation.rule),
    ).toEqual(expect.arrayContaining(["shell", "mount", "live-chat"]));
  });

  test("does not treat string-contained imports or shadowed locals as bindings", () => {
    const source = `const decoy = "import { WorkflowUiShell, NodeChatStream } from 'smithers-orchestrator/gateway-ui'; import { createGatewayReactRoot } from 'smithers-orchestrator/gateway-react'";
const App = (WorkflowUiShell) => <WorkflowUiShell />;
function render(NodeChatStream) { return <NodeChatStream />; }
function mount(createGatewayReactRoot) { createGatewayReactRoot(<App />); }`;
    const rules = gradeWorkflowUiSource(source, { requireNodeChat: true }).violations.map(
      (violation) => violation.rule,
    );
    expect(rules).toEqual(expect.arrayContaining(["shell", "mount", "live-chat"]));
  });

  test("matches namespace members and dollar-prefixed aliases exactly", () => {
    const valid = `import * as UI from "smithers-orchestrator/gateway-ui";
import { createGatewayReactRoot as $mount, WorkflowUiShell as $Shell, NodeChatStream as $Chat } from "smithers-orchestrator/gateway-react";
const App = () => <UI.WorkflowUiShell><UI.NodeChatStream /><$Shell><$Chat /></$Shell></UI.WorkflowUiShell>;
$mount(<App />);`;
    expect(gradeWorkflowUiSource(valid, { requireNodeChat: true }).passed).toBe(true);
    const forged = valid
      .replace("UI.WorkflowUiShell", "UIxWorkflowUiShell")
      .replace("UI.NodeChatStream", "UIxNodeChatStream")
      .replaceAll("<$Shell", "<xShell")
      .replaceAll("<$Chat", "<xChat")
      .replace("$mount(", "GatewayXcreateGatewayReactRoot(");
    expect(
      gradeWorkflowUiSource(forged, { requireNodeChat: true }).violations.map((violation) => violation.rule),
    ).toEqual(expect.arrayContaining(["shell", "mount", "live-chat"]));
  });

  test("ignores hex colors and tables inside comments", () => {
    const commented = `${COMPLIANT_UI}\n// legacy: background "#26262b" and a <table> we removed\n/* <table><tr/></table> #ffffff */\n`;
    expect(gradeWorkflowUiSource(commented, { requireNodeChat: false }).passed).toBe(true);
  });

  test("workflowHasAgentTasks distinguishes agent from deterministic workflows", () => {
    expect(workflowHasAgentTasks(AGENT_WORKFLOW)).toBe(true);
    expect(workflowHasAgentTasks(DETERMINISTIC_WORKFLOW)).toBe(false);
    expect(workflowHasAgentTasks(CHILD_PROMPT_WORKFLOW)).toBe(true);
    expect(workflowHasAgentTasks(DETERMINISTIC_CHILD_WORKFLOW)).toBe(false);
    expect(workflowHasAgentTasks(CREATE_UI_SHAPED_WORKFLOW)).toBe(true);
  });

  test("ignores fake agent syntax inside strings and templates", () => {
    const source =
      "const text = '<Workflow><Task agent={fake} /></Workflow>'; const template = `<Workflow><Task prompt={fake} /></Workflow>`;";
    expect(workflowHasAgentTasks(source)).toBe(false);
  });

  test("handles JSX attributes containing arrows and greater-than operators", () => {
    expect(workflowHasAgentTasks(`<Task when={(x) => x} agent={agents.smart}>prompt</Task>`)).toBe(true);
    expect(workflowHasAgentTasks(`<Task when={count > 0} agent={agents.smart}>prompt</Task>`)).toBe(true);
  });

  test("recognizes agent Tasks in the seeded pack corpus", () => {
    for (const file of [
      "orchbench.tsx",
      "make-workflow-tutorial.tsx",
      "bulletproof-ui-watchdog.tsx",
      "smithering.tsx",
    ]) {
      expect(
        workflowHasAgentTasks(
          readFileSync(resolve(import.meta.dir, "../../../.smithers/workflows", file), "utf8"),
          file,
        ),
      ).toBe(true);
    }
  });
});

test("rejects comment-separated forbidden side-effect imports", () => {
  const source = COMPLIANT_UI + ' import/* forbidden */"styled-components";';
  expect(
    gradeWorkflowUiSource(source, { requireNodeChat: false }).violations.map((violation) => violation.rule),
  ).toContain("imports");
});

test("requires bindings to come from the shipped entrypoint", () => {
  const forged =
    'import * as React from "react";\\nimport { WorkflowUiShell, NodeChatStream } from "./fake";\\nimport { createGatewayReactRoot } from "./fake";\\nconst App = () => <React.WorkflowUiShell><React.NodeChatStream /></React.WorkflowUiShell>;\\nReact.createGatewayReactRoot(<App />);';
  const rules = gradeWorkflowUiSource(forged, { requireNodeChat: true }).violations.map((violation) => violation.rule);
  expect(rules).toEqual(expect.arrayContaining(["shell", "mount", "live-chat"]));
});

test("does not accept imported names used as object properties", () => {
  const source =
    'import { WorkflowUiShell, NodeChatStream, createGatewayReactRoot } from "smithers-orchestrator/gateway-ui";\\nconst widgets = { WorkflowUiShell, NodeChatStream, createGatewayReactRoot };\\nconst App = () => <div />;\\nwidgets.createGatewayReactRoot(<App />);';
  const rules = gradeWorkflowUiSource(source, { requireNodeChat: true }).violations.map((violation) => violation.rule);
  expect(rules).toEqual(expect.arrayContaining(["shell", "mount", "live-chat"]));
});

describe("workflowUiComplianceScorer", () => {
  test("scores string output and reports violations in the reason", async () => {
    const good = await workflowUiComplianceScorer.score({ input: null, output: COMPLIANT_UI });
    expect(good.score).toBe(1);

    const bad = await workflowUiComplianceScorer.score({
      input: null,
      output: { uiSource: HAND_ROLLED_UI, workflowSource: AGENT_WORKFLOW },
    });
    expect(bad.score).toBeLessThan(1);
    expect(bad.reason).toContain("live-chat");
  });

  test("scores 0 with no UI source", async () => {
    const result = await workflowUiComplianceScorer.score({ input: null, output: undefined });
    expect(result.score).toBe(0);
  });
});

describe("JSX lexing", () => {
  test("a quoted JSX attribute before a self-closing tag does not swallow the mount as a regex", () => {
    const source = [
      'import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";',
      'import { WorkflowUiShell } from "smithers-orchestrator/gateway-ui";',
      'function App() { return <WorkflowUiShell title="Fixture" />; }',
      "createGatewayReactRoot(<App />);",
      "",
    ].join("\n");
    const report = gradeWorkflowUiSource(source);
    expect(report.violations.filter((violation) => violation.rule === "mount")).toEqual([]);
    expect(report.violations.filter((violation) => violation.rule === "shell")).toEqual([]);
  });

  test("division and real regex literals still mask correctly", () => {
    const source = [
      'import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";',
      'import { WorkflowUiShell } from "smithers-orchestrator/gateway-ui";',
      "const ratio = 1 / 2;",
      "const pattern = /createGatewayReactRoot\\(/g;",
      "void pattern; void ratio;",
      'createGatewayReactRoot(<WorkflowUiShell title="x" />);',
      "",
    ].join("\n");
    const report = gradeWorkflowUiSource(source);
    expect(report.violations.filter((violation) => violation.rule === "mount")).toEqual([]);
  });
});

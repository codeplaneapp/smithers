import { describe, expect, test } from "bun:test";
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

describe("gradeWorkflowUiSource", () => {
    test("passes a UI composed from the shipped design system", () => {
        const report = gradeWorkflowUiSource(COMPLIANT_UI, { workflowSource: AGENT_WORKFLOW });
        expect(report.violations).toEqual([]);
        expect(report.passed).toBe(true);
        expect(report.score).toBe(1);
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
        const noChat = COMPLIANT_UI.replace(/^.*NodeChatStream.*$/gm, "");
        expect(gradeWorkflowUiSource(noChat, { workflowSource: DETERMINISTIC_WORKFLOW }).passed).toBe(true);
        expect(
            gradeWorkflowUiSource(noChat, { workflowSource: AGENT_WORKFLOW }).violations.map((violation) => violation.rule),
        ).toContain("live-chat");
        expect(
            gradeWorkflowUiSource(noChat, { requireNodeChat: true }).violations.map((violation) => violation.rule),
        ).toContain("live-chat");
    });

    test("rejects imports outside react + the smithers subpaths", () => {
        const report = gradeWorkflowUiSource(
            `import styled from "styled-components";\n${COMPLIANT_UI}`,
            { requireNodeChat: false },
        );
        expect(report.violations.map((violation) => violation.rule)).toContain("imports");
    });

    test("ignores hex colors and tables inside comments", () => {
        const commented = `${COMPLIANT_UI}\n// legacy: background "#26262b" and a <table> we removed\n/* <table><tr/></table> #ffffff */\n`;
        expect(gradeWorkflowUiSource(commented, { requireNodeChat: false }).passed).toBe(true);
    });

    test("workflowHasAgentTasks distinguishes agent from deterministic workflows", () => {
        expect(workflowHasAgentTasks(AGENT_WORKFLOW)).toBe(true);
        expect(workflowHasAgentTasks(DETERMINISTIC_WORKFLOW)).toBe(false);
    });
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

/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smthrs/testing";

const workflowPath = join(import.meta.dir, "..", "workflows", "jjhub-issue-fleet.tsx");
let nonce = 0;
const moduleFor = async () => import(`${workflowPath}?jif=${++nonce}`);

const issueRow = (number: number) => ({
  number,
  title: `Issue ${number}`,
  body: "",
  labels: [] as string[],
});

const discoveryRow = (issues: number[]) => ({
  nodeId: "discover",
  iteration: 0,
  iterationCount: 0,
  ok: true,
  issues: issues.map(issueRow),
  mainChangeId: "change-main",
  baseRepoDir: "/tmp/jjhub-base",
});

describe("jjhub-issue-fleet workflow", () => {
  test("first frame runs discovery only", async () => {
    const workflow = (await moduleFor()).default;
    const frame = await renderWorkflow(workflow, { input: {}, outputs: {}, workflowPath });
    const nodeIds = frame.tasks.map(({ nodeId }) => nodeId);
    expect(nodeIds).toEqual(["discover"]);
    expect(frame.toXml()).toContain('"name":"jjhub-issue-fleet"');
  });

  test("a successful discovery fans one lane out per issue, PRs gated on pushed work", async () => {
    const workflow = (await moduleFor()).default;
    const frame = await renderWorkflow(workflow, {
      input: {},
      outputs: { discovery: [discoveryRow([101, 102])] },
      workflowPath,
    });
    const nodeIds = frame.tasks.map(({ nodeId }) => nodeId);
    expect(nodeIds).toContain("i101:lane");
    expect(nodeIds).toContain("i102:lane");
    // No lane has pushed yet, so no PR tasks and no summary mount.
    expect(nodeIds.filter((id) => id.endsWith(":pr"))).toEqual([]);
    expect(nodeIds).not.toContain("summary");
  });

  test("a failed discovery mounts no lanes", async () => {
    const workflow = (await moduleFor()).default;
    const frame = await renderWorkflow(workflow, {
      input: {},
      outputs: {
        discovery: [{ ...discoveryRow([101]), ok: false, issues: [], error: "token missing" }],
      },
      workflowPath,
    });
    expect(frame.tasks.map(({ nodeId }) => nodeId)).toEqual(["discover"]);
  });
});

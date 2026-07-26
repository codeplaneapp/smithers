import { describe, expect, test } from "bun:test";
import { renderWorkflow } from "smithers-orchestrator/testing";
import type { z } from "zod/v4";
import { quotaBeat } from "../ui/vibe-audit.tsx";
import workflow from "../workflows/vibe-audit.tsx";

const workflowPath = `${import.meta.dir}/../workflows/vibe-audit.tsx`;

describe("vibe-audit workflow", () => {
  test("registers its input schema so ctx.input carries the repo", () => {
    // createSmithers takes the input schema as the `input` KEY of its schemas
    // argument; the second argument is CreateSmithersOptions and has no `input`
    // field, so passing it there drops the schema and leaves ctx.input unknown.
    const inputSchema = (workflow as { inputSchema?: z.ZodType }).inputSchema;

    expect(inputSchema).toBeDefined();
    expect(inputSchema?.parse({})).toEqual({ repo: "acme/payments-api" });
  });

  test("runs four strategies in parallel ahead of the dedupe/triage/report chain", async () => {
    const frame = await renderWorkflow(workflow, { workflowPath, input: { repo: "acme/payments-api" } });

    expect(frame.tasks.map((task) => task.nodeId)).toEqual([
      "injection-scan",
      "auth-review",
      "secrets-scan",
      "deps-audit",
      "dedupe",
      "triage",
      "report",
    ]);
    // The deck's parked-on-quota beat needs a retry budget on deps-audit.
    expect(frame.tasks.find((task) => task.nodeId === "deps-audit")?.retries).toBe(2);
  });
});

describe("vibe-audit UI", () => {
  test('reads node completion as NodeStatus "ok", never "finished"', () => {
    expect(quotaBeat("ok", true)).toBe("recovered");
    expect(quotaBeat("running", true)).toBe("parked");
    expect(quotaBeat("failed", true)).toBe("parked");
    expect(quotaBeat("ok", false)).toBe("none");
  });
});

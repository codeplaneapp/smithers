import { describe, expect, test } from "bun:test";
import { renderWorkflow } from "smithers-orchestrator/testing";
import type { z } from "zod/v4";
import { quotaBeat } from "../ui/vibe-audit.tsx";
import workflow from "../workflows/vibe-audit.tsx";

const workflowPath = `${import.meta.dir}/../workflows/vibe-audit.tsx`;

type XmlNode = { tag?: string; props?: Record<string, unknown>; children?: XmlNode[] };

const childIds = (node: XmlNode | undefined): string[] =>
  (node?.children ?? []).map((child) => String(child.props?.id ?? ""));

describe("vibe-audit workflow", () => {
  test("registers its input schema so ctx.input carries the repo", () => {
    // createSmithers takes the input schema as the `input` KEY of its schemas
    // argument; the second argument is CreateSmithersOptions and has no `input`
    // field, so passing it there drops the schema and leaves ctx.input unknown.
    const inputSchema = (workflow as { inputSchema?: z.ZodType }).inputSchema;

    expect(inputSchema).toBeDefined();
    expect(inputSchema?.parse({})).toEqual({ repo: "acme/payments-api" });
    expect(inputSchema?.parse({ repo: "smithersai/payments-api" })).toEqual({ repo: "smithersai/payments-api" });
    expect((inputSchema as z.ZodType | undefined)?.safeParse({ repo: 42 }).success).toBe(false);
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

  test("fans the four scans out under <Parallel>, then funnels dedupe -> triage -> report", async () => {
    // `frame.tasks` is a flat list, so it reads the same whether the scans are
    // concurrent or sequential. Assert the rendered graph itself: only the tree
    // shape pins the demo's fan-out/funnel beat.
    const frame = await renderWorkflow(workflow, { workflowPath, input: { repo: "acme/payments-api" } });
    const root = JSON.parse(frame.toXml()) as XmlNode;

    expect(root.tag).toBe("smithers:workflow");
    expect(root.props?.name).toBe("vibe-audit");

    const sequence = root.children?.[0];
    expect(sequence?.tag).toBe("smithers:sequence");

    const parallel = sequence?.children?.[0];
    expect(parallel?.tag).toBe("smithers:parallel");
    expect(childIds(parallel)).toEqual(["injection-scan", "auth-review", "secrets-scan", "deps-audit"]);

    // The consolidation pipeline runs strictly after the parallel scans, in order.
    expect((sequence?.children ?? []).slice(1).map((child) => String(child.props?.id ?? ""))).toEqual([
      "dedupe",
      "triage",
      "report",
    ]);
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

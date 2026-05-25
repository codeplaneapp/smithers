import { describe, expect, test } from "vitest";
import { findOverlappingRects, nodeRects, validateLayout, workflowToFlow } from "../src/layout";
import { generateWorkflowFromPrompt } from "../src/workflowModel";

describe("workflow layout", () => {
  test("auto-layout spaces generated nodes without overlap", () => {
    const spec = generateWorkflowFromPrompt(
      "Research, build, document, test, validate, and release a multi-agent workflow",
    );
    const flow = workflowToFlow(spec);
    const validation = validateLayout(flow.nodes);

    expect(validation.valid).toBe(true);
    expect(validation.overlaps).toEqual([]);
    expect(nodeRects(flow.nodes)).toHaveLength(spec.nodes.length);
  });

  test("overlap detector fails when node rectangles collide", () => {
    const overlaps = findOverlappingRects(
      [
        { id: "a", x: 0, y: 0, width: 220, height: 96 },
        { id: "b", x: 30, y: 20, width: 220, height: 96 },
      ],
      12,
    );

    expect(overlaps).toEqual([["a", "b"]]);
  });
});

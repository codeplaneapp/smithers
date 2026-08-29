import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"

const flow = Flow.make("engine/Lineage", { payload: {}, success: Schema.String, body: () => Node.succeed("ready") })

describe("FlowEngine.Lineage", () => {
  it("addresses a run's root, and a node by its path from that root", () => {
    expect(FlowEngine.Lineage.root("run-1")).toBe("run-1/root")
    expect(FlowEngine.Lineage.make("run-1")).toBe("run-1/root")
    expect(FlowEngine.Lineage.make("run-1", [])).toBe("run-1/root")
    expect(FlowEngine.Lineage.make("run-1", ["agent", "step-3"])).toBe("run-1/root/agent/step-3")
  })

  it("is carried on the instance a runtime hands a flow", () => {
    // The frame address `(lineageId, seq)` starts here: every durable record
    // the run writes stamps this into `meta.lineageId`.
    expect(FlowEngine.makeInstance(flow, "run-1").lineageId).toBe("run-1/root")
  })
})

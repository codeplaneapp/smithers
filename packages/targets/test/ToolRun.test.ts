import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import { HttpSecret, Secret } from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import { ToolRun } from "../src/ToolRun.ts"

describe("ToolRun", () => {
  it("declares a run-kind, non-cacheable target gated to the run verb", () => {
    const target = ToolRun({
      command: "firectl",
      args: ["dataset", "create", "pilot", "data/pilot.jsonl"],
      inputs: [Input.file("data/pilot.jsonl")],
      deps: [],
      secrets: [HttpSecret(Secret("FIREWORKS_API_KEY"), ["https://api.fireworks.ai"])],
      cwd: "evals/authoring"
    })
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("ToolRun")
    expect(metadata.kinds).toEqual(["run"])
    // Never cacheable: it performs an external side effect with no outputs.
    expect(metadata.cacheable).toBe(false)
    // The verb gate keeps it out of build, test, and lint graphs, so a side
    // effect never rides along with a `ci` run.
    expect(metadata.verbGate).toEqual(["run"])
    expect(metadata.inputs).toHaveLength(1)
  })

  it("collects dependency edges so an operation can order behind a check", () => {
    const validate = ToolRun({
      command: "node",
      args: ["validate.mjs"],
      inputs: [],
      deps: [],
      cwd: "evals/authoring"
    })
    const launch = ToolRun({
      command: "firectl",
      args: ["supervised-fine-tuning-job", "create"],
      inputs: [],
      deps: [validate],
      cwd: "evals/authoring"
    })
    expect(Target.metadata(launch).dependencies).toContain(validate)
  })

  it("defaults the optional attributes so a bare command needs no env or codes", () => {
    const target = ToolRun({
      command: "firectl",
      args: ["whoami"],
      inputs: [],
      deps: []
    })
    const metadata = Target.metadata(target)
    expect(metadata.kinds).toEqual(["run"])
    expect(metadata.cacheable).toBe(false)
  })
})

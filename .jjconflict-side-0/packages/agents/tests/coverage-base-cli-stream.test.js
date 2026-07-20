import { describe, expect, test } from "bun:test";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";

// A minimal CLI agent whose command is a plain shell echo. It overrides nothing
// but buildCommand, so it exercises BaseCliAgent's own stream() wrapper and the
// default createOutputInterpreter()/diagnosticHints() (both return undefined).
class StreamAgent extends BaseCliAgent {
  script;
  /**
   * @param {string} script
   * @param {import("../src/BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} [opts]
   */
  constructor(script, opts = {}) {
    super({ id: "stream-test-agent", ...opts });
    this.script = script;
  }
  async buildCommand() {
    return { command: "bash", args: ["-lc", this.script] };
  }
}

describe("BaseCliAgent stream()", () => {
  test("wraps the generate result into a drainable StreamTextResult", async () => {
    const agent = new StreamAgent("echo streamed answer");
    const stream = await agent.stream({ prompt: "run" });

    const drain = async (readable) => {
      const reader = readable.getReader();
      const out = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
      return out;
    };

    const textChunks = await drain(stream.textStream);
    expect(textChunks.join("").trim()).toBe("streamed answer");

    const partTypes = (await drain(stream.fullStream)).map((part) => part.type);
    expect(partTypes).toContain("text-start");
    expect(partTypes).toContain("text-delta");
    expect(partTypes).toContain("text-end");

    // The derived promises resolve from the same underlying generate result.
    expect((await stream.text).trim()).toBe("streamed answer");
    expect(await stream.finishReason).toBe("stop");
    const usage = await stream.usage;
    expect(usage).toBeDefined();
    const steps = await stream.steps;
    expect(Array.isArray(steps)).toBe(true);
  });

  test("default createOutputInterpreter() and diagnosticHints() are undefined", () => {
    const agent = new StreamAgent("echo ignored");
    expect(agent.createOutputInterpreter()).toBeUndefined();
    expect(agent.diagnosticHints()).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop(), { recursive: true, force: true });
  }
});

class OutputFileAgent extends BaseCliAgent {
  outputFile;

  constructor(outputFile) {
    super({ id: "output-file-usage-test-agent" });
    this.outputFile = outputFile;
  }

  async buildCommand() {
    const output = JSON.stringify("final answer from output file");
    const event = JSON.stringify({
      type: "usage",
      usage: { input_tokens: 123, output_tokens: 45 },
    });
    const script = `require("node:fs").writeFileSync(${JSON.stringify(this.outputFile)}, ${output}); process.stdout.write(${JSON.stringify(event)});`;
    return {
      command: process.execPath,
      args: ["-e", script],
      outputFile: this.outputFile,
    };
  }
}

describe("BaseCliAgent output-file usage extraction", () => {
  test("extracts usage from raw stdout when the answer is in outputFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-output-file-usage-test-"));
    cleanups.push(dir);
    const outputFile = join(dir, "answer.txt");
    const result = await new OutputFileAgent(outputFile).generate({ prompt: "test" });

    expect(result.text).toBe("final answer from output file");
    expect(result.usage?.inputTokens).toBe(123);
    expect(result.usage?.outputTokens).toBe(45);
  });
});

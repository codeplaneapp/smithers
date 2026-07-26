import { describe, expect, test } from "bun:test";
import { OpenCodeAgent } from "../src/OpenCodeAgent.js";

/**
 * Value of the `--variant X` flag in an argv, if present.
 * @param {string[]} args
 * @returns {string | undefined}
 */
function variantValue(args) {
  const idx = args.indexOf("--variant");
  return idx >= 0 && typeof args[idx + 1] === "string" ? args[idx + 1] : undefined;
}

describe("OpenCodeAgent effort → variant mapping", () => {
  test("effort defaults the provider-defined --variant when variant is unset", async () => {
    const cmd = await new OpenCodeAgent({ effort: "high" }).buildCommand({
      prompt: "go",
      cwd: process.cwd(),
      options: {},
    });
    expect(cmd.command).toBe("opencode");
    expect(variantValue(cmd.args)).toBe("high");
  });

  test("explicit variant WINS over effort", async () => {
    const cmd = await new OpenCodeAgent({ effort: "high", variant: "thinking" }).buildCommand({
      prompt: "go",
      cwd: process.cwd(),
      options: {},
    });
    expect(variantValue(cmd.args)).toBe("thinking");
    // Exactly one --variant flag.
    expect(cmd.args.filter((a) => a === "--variant").length).toBe(1);
  });

  test("no effort and no variant → no --variant flag", async () => {
    const cmd = await new OpenCodeAgent({}).buildCommand({
      prompt: "go",
      cwd: process.cwd(),
      options: {},
    });
    expect(cmd.args).not.toContain("--variant");
  });
});

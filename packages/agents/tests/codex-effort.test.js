import { describe, expect, test } from "bun:test";
import { CodexAgent } from "../src/CodexAgent.js";

/**
 * Extract the value of a `-c key=...` Codex config override from an argv.
 * @param {string[]} args
 * @param {string} key
 * @returns {string | undefined}
 */
function configOverride(args, key) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" && typeof args[i + 1] === "string" && args[i + 1].startsWith(`${key}=`)) {
      return args[i + 1].slice(`${key}=`.length);
    }
  }
  return undefined;
}

describe("CodexAgent first-class effort", () => {
  test("effort becomes the default -c model_reasoning_effort", async () => {
    const cmd = await new CodexAgent({ effort: "high" }).buildCommand({
      prompt: "go",
      cwd: process.cwd(),
      options: {},
    });
    try {
      expect(cmd.command).toBe("codex");
      expect(configOverride(cmd.args, "model_reasoning_effort")).toBe("high");
    } finally {
      await cmd.cleanup?.();
    }
  });

  test("explicit config.model_reasoning_effort WINS over effort", async () => {
    const cmd = await new CodexAgent({
      effort: "high",
      config: { model_reasoning_effort: "low" },
    }).buildCommand({
      prompt: "go",
      cwd: process.cwd(),
      options: {},
    });
    try {
      expect(configOverride(cmd.args, "model_reasoning_effort")).toBe("low");
      // Exactly one override for the key — no duplicate -c.
      const count = cmd.args.filter(
        (a, i) =>
          a === "-c" && typeof cmd.args[i + 1] === "string" && cmd.args[i + 1].startsWith("model_reasoning_effort="),
      ).length;
      expect(count).toBe(1);
    } finally {
      await cmd.cleanup?.();
    }
  });

  test("array config entries are preserved when effort supplies the default", async () => {
    const cmd = await new CodexAgent({
      effort: "high",
      config: ["sandbox_workspace_write.network_access=true", "features.web_search=true"],
    }).buildCommand({
      prompt: "go",
      cwd: process.cwd(),
      options: {},
    });
    try {
      expect(configOverride(cmd.args, "sandbox_workspace_write.network_access")).toBe("true");
      expect(configOverride(cmd.args, "features.web_search")).toBe("true");
      expect(configOverride(cmd.args, "model_reasoning_effort")).toBe("high");
    } finally {
      await cmd.cleanup?.();
    }
  });

  test("explicit array model_reasoning_effort wins without dropping sibling entries", async () => {
    const cmd = await new CodexAgent({
      effort: "high",
      config: ["sandbox_workspace_write.network_access=true", "model_reasoning_effort=low"],
    }).buildCommand({
      prompt: "go",
      cwd: process.cwd(),
      options: {},
    });
    try {
      expect(configOverride(cmd.args, "sandbox_workspace_write.network_access")).toBe("true");
      expect(configOverride(cmd.args, "model_reasoning_effort")).toBe("low");
      expect(
        cmd.args.filter(
          (a, i) =>
            a === "-c" && typeof cmd.args[i + 1] === "string" && cmd.args[i + 1].startsWith("model_reasoning_effort="),
        ),
      ).toHaveLength(1);
    } finally {
      await cmd.cleanup?.();
    }
  });
});

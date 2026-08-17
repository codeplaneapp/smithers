import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CodexAgent } from "../src/CodexAgent.js";

const codexModule = fileURLToPath(new URL("../src/CodexAgent.js", import.meta.url));

describe("CLI agent option boundary", () => {
  test("a real child process rejects unknown options instead of silently dropping them", () => {
    const child = Bun.spawnSync([
      process.execPath,
      "--eval",
      `import { CodexAgent } from ${JSON.stringify(codexModule)}; new CodexAgent({ inheritEnvironment: false });`,
    ]);
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toContain("CodexAgent received unknown option: inheritEnvironment");
  });

  test("declared base options remain accepted by concrete agents", () => {
    const agent = new CodexAgent({ inheritEnv: false });
    expect(agent.inheritEnv).toBe(false);
  });
});

/**
 * Unit tests for the init preferred-agent question — the ONE selection
 * interactive `smithers init` asks for. Only the promptless paths run here
 * (flag preselect, single-agent auto-pick, zero-agent null); the clack select
 * itself needs a TTY.
 */
import { describe, expect, test } from "bun:test";
import { buildPreferredAgentOptions, selectPreferredAgent } from "../src/init/selectPreferredAgent.js";

/** Minimal AgentAvailability fixture. */
function det(id, over = {}) {
  return {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    binary: id,
    hasBinary: true,
    hasAuthSignal: true,
    hasApiKeySignal: false,
    hasProjectTrustSignal: false,
    status: "likely-subscription",
    score: 3,
    usable: true,
    checks: [],
    unusableReasons: [],
    ...over,
  };
}

describe("buildPreferredAgentOptions", () => {
  test("offers only usable, non-deprecated agents", () => {
    const options = buildPreferredAgentOptions([
      det("claude"),
      det("codex", { usable: false, unusableReasons: ["binary not found"] }),
      det("kimi", { deprecated: true }),
    ]);
    expect(options.map((o) => o.value)).toEqual(["claude"]);
  });

  test("orders by detection score, strongest first", () => {
    const options = buildPreferredAgentOptions([
      det("pi", { score: 1 }),
      det("claude", { score: 5 }),
      det("codex", { score: 3 }),
    ]);
    expect(options.map((o) => o.value)).toEqual(["claude", "codex", "pi"]);
  });

  test("carries a human status hint", () => {
    const [option] = buildPreferredAgentOptions([det("claude", { status: "api-key" })]);
    expect(option.hint).toBe("API key detected");
  });
});

describe("selectPreferredAgent", () => {
  test("--agent preselect skips the prompt and returns the detection", async () => {
    const detections = [det("claude"), det("codex")];
    const choice = await selectPreferredAgent({ env: {}, preselect: "codex", detections });
    expect(choice.source).toBe("flag");
    expect(choice.detection.id).toBe("codex");
  });

  test("unknown --agent id fails loud instead of prompting", async () => {
    const detections = [det("claude")];
    await expect(selectPreferredAgent({ env: {}, preselect: "nope", detections })).rejects.toThrow(
      /Unknown agent "nope"/,
    );
  });

  test("exactly one usable agent is auto-picked without a prompt", async () => {
    const detections = [det("claude"), det("codex", { usable: false, unusableReasons: ["not logged in"] })];
    const choice = await selectPreferredAgent({ env: {}, detections });
    expect(choice.source).toBe("auto");
    expect(choice.detection.id).toBe("claude");
  });

  test("no usable agents returns null", async () => {
    const detections = [det("claude", { usable: false, unusableReasons: ["binary not found"] })];
    const choice = await selectPreferredAgent({ env: {}, detections });
    expect(choice).toBeNull();
  });
});

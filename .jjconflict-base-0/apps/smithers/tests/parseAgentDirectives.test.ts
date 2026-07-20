import { describe, expect, test } from "bun:test";
import { parseAgentDirectives } from "../src/control/parseAgentDirectives";

/**
 * The app-control directive protocol — how the concierge backgrounds workflows
 * and drives the UI exactly like ../multi. The model ends its reply with a fenced
 * `smithers:action` JSONL block; the client parses it here and executes (gated by
 * the approval ring). CI-safe and deterministic (no model call).
 */
describe("parseAgentDirectives", () => {
  test("lifts a launchRun directive out of the reply and strips the block", () => {
    const text =
      "On it.\n```smithers:action\n" +
      '{"tool":"requestControl","reason":"start a build"}\n' +
      '{"tool":"startWorkflow","args":{"workflowKey":"implement","inputs":{"prompt":"dark mode"}}}\n' +
      "```";
    const { cleanedText, directives } = parseAgentDirectives(text);
    expect(cleanedText.trim()).toBe("On it.");
    expect(directives).toHaveLength(2);
    expect(directives[0].tool).toBe("requestControl");
    expect(directives[1]).toMatchObject({
      tool: "startWorkflow",
      args: { workflowKey: "implement" },
    });
  });

  test("plain chat with no action block yields no directives", () => {
    const { cleanedText, directives } = parseAgentDirectives("Just a normal answer.");
    expect(cleanedText).toBe("Just a normal answer.");
    expect(directives).toHaveLength(0);
  });

  test("a half-streamed (unterminated) block is stripped and yields no directives", () => {
    const { cleanedText, directives } = parseAgentDirectives(
      'Working on it.\n```smithers:action\n{"tool":"setTheme"',
    );
    expect(cleanedText.trim()).toBe("Working on it.");
    expect(directives).toHaveLength(0);
  });
});

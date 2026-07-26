import { describe, expect, test } from "bun:test";
import { classifySessionLoss } from "../src/BaseCliAgent/BaseCliAgent.js";

/**
 * Session-loss classification: a dead resume/session id must produce a typed
 * AGENT_SESSION_LOST error with `discardResumeSession: true`, so the engine
 * retry path mints a fresh conversation instead of dead-looping `--resume
 * <dead-id>` through every attempt (issue-swarm run-1784095071179).
 */
describe("classifySessionLoss", () => {
  test("claude 'No conversation found' on the error text is session loss", () => {
    const err = classifySessionLoss(
      "claude",
      "No conversation found with session ID: 7c88b910-6018-40ec-8f6d-4ec5f5295ed9",
      "",
    );
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
    expect(err.details.discardResumeSession).toBe(true);
    expect(err.details.failureRetryable).toBe(true);
    expect(err.message).toContain("7c88b910-6018-40ec-8f6d-4ec5f5295ed9");
  });

  test("claude 'No conversation found' on stderr only is session loss", () => {
    const err = classifySessionLoss(
      "claude",
      "Claude exited with code 1",
      "No conversation found with session ID: f6be968c-59cd-44e5-910c-1bcc4081ede4",
    );
    expect(err).not.toBeNull();
    expect(err.details.discardResumeSession).toBe(true);
  });

  test("claude message without a parseable id still classifies", () => {
    const err = classifySessionLoss("claude", "No conversation found with session ID", "");
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
  });

  test("kimi resume banner is session loss with the id captured", () => {
    const err = classifySessionLoss("kimi", "", "To resume this session: kimi -r 0a1b2c3d-4e5f-6789-abcd-ef0123456789");
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
    expect(err.details.kimiSessionId).toBe("0a1b2c3d-4e5f-6789-abcd-ef0123456789");
    expect(err.details.discardResumeSession).toBe(true);
  });

  test("the claude pattern on a different CLI is NOT session loss", () => {
    expect(classifySessionLoss("codex", "No conversation found with session ID: abc12345", "")).toBeNull();
  });

  test("an ordinary claude failure is NOT session loss", () => {
    expect(classifySessionLoss("claude", "CLI timed out after 4500000ms", "")).toBeNull();
  });
});

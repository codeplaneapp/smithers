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

  test("claude 'No conversation found' on a FRESH session is flagged so the chain fails over", () => {
    const err = classifySessionLoss(
      "claude",
      "No conversation found with session ID: 6375a571-173f-4de8-b914-87500f95065f",
      "",
      false,
    );
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
    expect(err.details.freshSessionFailure).toBe(true);
    // Still discard the id: the heartbeat may have captured the broken one.
    expect(err.details.discardResumeSession).toBe(true);
    expect(err.message).toContain("FRESH session");
    expect(err.message).not.toContain("Retry will start a fresh session");
  });

  test("claude session loss WITH a resume id keeps the retry-fresh message", () => {
    const err = classifySessionLoss("claude", "No conversation found with session ID: abc12345", "", true);
    expect(err.details.freshSessionFailure).toBe(false);
    expect(err.message).toContain("Retry will start a fresh session");
  });

  test("kimi resume banner is session loss with the id captured", () => {
    const err = classifySessionLoss("kimi", "", "To resume this session: kimi -r 0a1b2c3d-4e5f-6789-abcd-ef0123456789");
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
    expect(err.details.kimiSessionId).toBe("0a1b2c3d-4e5f-6789-abcd-ef0123456789");
    expect(err.details.discardResumeSession).toBe(true);
  });

  test("kimi crash on a FRESH session is flagged so it counts as an agent failure, not a fixable resume", () => {
    const err = classifySessionLoss(
      "kimi",
      "",
      "To resume this session: kimi -r 0a1b2c3d-4e5f-6789-abcd-ef0123456789",
      false,
    );
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
    expect(err.details.freshSessionFailure).toBe(true);
    // Still discard the broken id: the heartbeat may have captured it.
    expect(err.details.discardResumeSession).toBe(true);
    expect(err.message).toContain("FRESH session");
    expect(err.message).not.toContain("Retry will start a fresh session");
  });

  test("claude crash on a FRESH session is flagged so it counts as an agent failure, not a fixable resume", () => {
    const err = classifySessionLoss(
      "claude",
      "No conversation found with session ID: 68b187d0-a325-4384-a248-b2a0e6edbd90",
      "",
      false,
    );
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
    expect(err.details.freshSessionFailure).toBe(true);
    // Still discard the broken id: the heartbeat may have captured it.
    expect(err.details.discardResumeSession).toBe(true);
    expect(err.message).toContain("FRESH session");
    expect(err.message).not.toContain("Retry will start a fresh session");
  });

  test("a resumed claude session is flagged as recoverable so it does not consume retry budget", () => {
    const err = classifySessionLoss(
      "claude",
      "No conversation found with session ID: 68b187d0-a325-4384-a248-b2a0e6edbd90",
      "",
      true,
    );
    expect(err.details.freshSessionFailure).toBe(false);
    expect(err.message).toContain("Retry will start a fresh session");
  });

  test("the claude pattern on a different CLI is NOT session loss", () => {
    expect(classifySessionLoss("codex", "No conversation found with session ID: abc12345", "")).toBeNull();
  });

  test("an ordinary claude failure is NOT session loss", () => {
    expect(classifySessionLoss("claude", "CLI timed out after 4500000ms", "")).toBeNull();
  });

  // A codex response stream that drops before the rollout is recorded leaves a
  // captured thread id that was never persisted. Verbatim second-attempt error
  // from five separate runs on 2026-08-17, each of which then burned all 19
  // attempts resuming the same non-existent thread.
  const CODEX_DEAD_THREAD =
    "Error: thread/resume: thread/resume failed: no rollout found for thread id " +
    "01a00cb3-1065-73b0-b422-366bc0585f4d (code -32600)";

  test("codex 'no rollout found for thread id' on the error text is session loss", () => {
    const err = classifySessionLoss("codex", CODEX_DEAD_THREAD, "");
    expect(err).not.toBeNull();
    expect(err.code).toBe("AGENT_SESSION_LOST");
    expect(err.details.discardResumeSession).toBe(true);
    expect(err.details.failureRetryable).toBe(true);
    expect(err.details.command).toBe("codex");
    expect(err.details.codexThreadId).toBe("01a00cb3-1065-73b0-b422-366bc0585f4d");
    expect(err.message).toContain("Retry will start a fresh session");
  });

  test("codex dead rollout on stderr is session loss", () => {
    const err = classifySessionLoss("codex", "", CODEX_DEAD_THREAD);
    expect(err).not.toBeNull();
    expect(err.details.discardResumeSession).toBe(true);
  });

  test("codex dead rollout on a FRESH session reports honestly and does not promise a retry", () => {
    const err = classifySessionLoss("codex", CODEX_DEAD_THREAD, "", false);
    expect(err).not.toBeNull();
    expect(err.details.freshSessionFailure).toBe(true);
    expect(err.details.discardResumeSession).toBe(true);
    expect(err.message).toContain("FRESH session");
    expect(err.message).not.toContain("Retry will start a fresh session");
  });

  test("the codex pattern on a different CLI is NOT session loss", () => {
    expect(classifySessionLoss("claude", CODEX_DEAD_THREAD, "")).toBeNull();
  });

  test("an ordinary codex failure is NOT session loss", () => {
    expect(
      classifySessionLoss(
        "codex",
        "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
        "",
      ),
    ).toBeNull();
  });
});

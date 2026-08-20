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

  test("the claude pattern on a different CLI is NOT session loss", () => {
    expect(classifySessionLoss("codex", "No conversation found with session ID: abc12345", "")).toBeNull();
  });

  test("an ordinary claude failure is NOT session loss", () => {
    expect(classifySessionLoss("claude", "CLI timed out after 4500000ms", "")).toBeNull();
  });
  /*
   * A provider quota rejection prints its own resume hint on the way out. Kimi's
   * billing-cycle 403 ends with "To resume this session: kimi -r <id>", so the
   * resume matcher used to claim it and mark it retryable — every task then burned
   * its whole attempt budget in ~3s bursts against an account with no quota left,
   * reporting "the kimi CLI is failing to establish sessions" instead of the truth.
   */
  test("kimi billing-cycle quota is quota, not session loss, even with a resume hint", () => {
    const stdout = [
      "Server: Error code: 403 - {'error': {'message': \"You've reached your usage limit for this",
      "billing cycle. Your quota will be refreshed in the next cycle.\", 'type': 'access_terminated_error'}}",
      "",
      "To resume this session: kimi -r 34ca2c90-0382-45b7-a64a-a717d93c1cc3",
    ].join("\n");
    expect(classifySessionLoss("kimi", stdout, "", false)).toBeNull();
  });

  test("kimi quota banner on stderr still beats a resume hint on the error text", () => {
    expect(
      classifySessionLoss(
        "kimi",
        "To resume this session: kimi -r 34ca2c90-0382-45b7-a64a-a717d93c1cc3",
        "You've reached your usage limit for this billing cycle.",
        false,
      ),
    ).toBeNull();
  });

  test("a genuine kimi session loss is still classified", () => {
    expect(classifySessionLoss("kimi", "To resume this session: kimi -r abc12345-dead", "")).toMatchObject({
      code: "AGENT_SESSION_LOST",
      details: { command: "kimi", discardResumeSession: true },
    });
  });
});

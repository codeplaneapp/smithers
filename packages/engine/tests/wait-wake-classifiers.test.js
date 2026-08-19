import { describe, expect, test } from "bun:test";
import { classifyQuotaError } from "@smthrs/agents/BaseCliAgent/BaseCliAgent";
import {
  classifyError,
  defaultWaitWakeClassifiers,
  resolveRetry,
} from "@smthrs/engine/classify/defaultWaitWakeClassifiers";
import { knownProviderFamilies, providerFamilyFor } from "@smthrs/engine/classify/providerFamily";
import { createWaitingSeam } from "@smthrs/engine/waiting/createWaitingSeam";
import { resolveFailedAttemptsDisposition, resolveQuotaWakeAt } from "@smthrs/engine/engine";

const NOW = 1_800_000_000_000;

/**
 * Build the attempt row a quota failure actually reaches the seam as: the
 * agent layer's own `classifyQuotaError` output, serialized the way
 * `adapter.updateAttempt` stores it. Using the real classifier keeps this test
 * honest about the provider text the engine sees.
 */
function attemptRowFor(message, command, engine) {
  const error = classifyQuotaError(message, command, {
    agentId: "worker",
    agentEngine: engine,
    agentModel: "test-model",
    nowMs: () => NOW,
  });
  if (!error) throw new Error(`classifyQuotaError did not recognise: ${message}`);
  return {
    state: "failed",
    errorJson: JSON.stringify({ code: error.code, message: error.message, details: error.details }),
    metaJson: JSON.stringify({ kind: "agent" }),
  };
}

describe("provider families", () => {
  test("the engine id decides the family", () => {
    expect(providerFamilyFor("claude-code", "")).toBe("anthropic");
    expect(providerFamilyFor("codex", "")).toBe("openai");
    expect(providerFamilyFor("gemini", "")).toBe("google");
    expect(providerFamilyFor("grok", "")).toBe("xai");
    expect(providerFamilyFor("some-unknown-cli", "")).toBe("unknown");
  });

  test("the message decides it when the engine id is missing", () => {
    expect(providerFamilyFor(null, "You are out of usage credits")).toBe("anthropic");
    expect(providerFamilyFor(null, '{"error":"usage_limit_reached"}')).toBe("openai");
    expect(providerFamilyFor(null, "RESOURCE_EXHAUSTED: quota exceeded")).toBe("google");
  });
});

describe("classifyError", () => {
  test.each([
    ["anthropic", "claude-code", "You've reached your usage limit. Your limit will reset at 4pm (America/New_York)."],
    ["openai", "codex", 'Too many requests: {"type":"usage_limit_reached"} retry after 900 seconds'],
    ["google", "gemini", "RESOURCE_EXHAUSTED: quota exceeded, retry after 120 seconds"],
    ["xai", "grok", "rate limit exceeded — retry after 60 seconds"],
  ])("a %s quota failure parks with a wake deadline", (family, engine, message) => {
    const classification = classifyError(attemptRowFor(message, engine, engine), { nowMs: NOW });
    expect(classification.kind).toBe("quota");
    expect(classification.providerFamily).toBe(family);
    expect(classification.wakeAt).toBeGreaterThan(NOW);

    const resolution = resolveRetry(classification, { nowMs: NOW, attemptsUsed: 3, retries: 1 });
    // A quota failure never spends a retry, even with the budget already gone.
    expect(resolution).toEqual({ action: "park", reason: "quota", wakeAt: classification.wakeAt });
  });

  test("a quota failure the provider gave no deadline for parks without one", () => {
    const classification = classifyError(
      { errorJson: JSON.stringify({ code: "AGENT_QUOTA_EXCEEDED", details: { failureQuota: true } }) },
      { nowMs: NOW },
    );
    expect(classification.kind).toBe("quota");
    expect(classification.wakeAt).toBeUndefined();
    expect(resolveRetry(classification, { nowMs: NOW, attemptsUsed: 0, retries: 3 })).toEqual({
      action: "park",
      reason: "quota",
    });
  });

  test("a deadline already in the past is not a deadline", () => {
    const classification = classifyError(
      {
        errorJson: JSON.stringify({
          code: "AGENT_QUOTA_EXCEEDED",
          details: { failureQuota: true, quotaResetAtMs: NOW - 1 },
        }),
      },
      { nowMs: NOW },
    );
    expect(classification.wakeAt).toBeUndefined();
  });

  test("a deterministic configuration failure is fatal, not transient", () => {
    const classification = classifyError(
      { errorJson: JSON.stringify({ code: "AGENT_CONFIG_INVALID", message: "LLM not set" }) },
      { nowMs: NOW },
    );
    expect(classification.kind).toBe("fatal");
    expect(resolveRetry(classification, { nowMs: NOW, attemptsUsed: 0, retries: 5 })).toEqual({
      action: "fail",
      reason: "non-retryable",
    });
  });

  test("an explicit failureRetryable flag beats every heuristic", () => {
    expect(
      classifyError(
        {
          errorJson: JSON.stringify({ code: "AGENT_CONFIG_INVALID" }),
          metaJson: JSON.stringify({ failureRetryable: true }),
        },
        { nowMs: NOW },
      ).kind,
    ).toBe("transient");
    expect(classifyError({ metaJson: JSON.stringify({ failureRetryable: false }) }, { nowMs: NOW }).kind).toBe("fatal");
  });

  test("invalid output is fatal for a compute task and retryable for an agent", () => {
    const errorJson = JSON.stringify({ code: "INVALID_OUTPUT" });
    expect(classifyError({ errorJson, metaJson: JSON.stringify({ kind: "compute" }) }, { nowMs: NOW }).kind).toBe(
      "fatal",
    );
    expect(classifyError({ errorJson, metaJson: JSON.stringify({ kind: "agent" }) }, { nowMs: NOW }).kind).toBe(
      "transient",
    );
  });

  test("a transient failure retries until the budget is gone, then fails", () => {
    const transient = { kind: "transient", providerFamily: "unknown" };
    expect(resolveRetry(transient, { nowMs: NOW, attemptsUsed: 0, retries: 2 })).toEqual({
      action: "retry",
      waitMs: 1_000,
    });
    expect(resolveRetry(transient, { nowMs: NOW, attemptsUsed: 2, retries: 2 })).toEqual({
      action: "retry",
      waitMs: 4_000,
    });
    expect(resolveRetry(transient, { nowMs: NOW, attemptsUsed: 3, retries: 2 })).toEqual({
      action: "fail",
      reason: "budget-exhausted",
    });
  });
});

describe("the classifiers are injected, not hard-wired", () => {
  test("a host can replace classifyError at the seam", async () => {
    const seam = createWaitingSeam({
      classifiers: {
        classifyError: () => ({ kind: "quota", providerFamily: "unknown", wakeAt: NOW + 60_000 }),
      },
      nowMs: () => NOW,
    });
    // The replacement classifier drives the resolution; the default resolveRetry
    // is still in play, which is what "inject one service" has to mean.
    expect(seam.resolveRetry({}, { attemptsUsed: 99, retries: 0 })).toEqual({
      action: "park",
      reason: "quota",
      wakeAt: NOW + 60_000,
    });
  });

  test("the default pair is what an uninjected seam uses", () => {
    expect(defaultWaitWakeClassifiers.classifyError).toBe(classifyError);
    expect(defaultWaitWakeClassifiers.resolveRetry).toBe(resolveRetry);
  });
});

describe("resolveQuotaWakeAt", () => {
  const seam = createWaitingSeam({ nowMs: () => NOW });

  test("takes the earliest deadline any blocked provider offered", () => {
    const wakeAt = resolveQuotaWakeAt(
      {
        _tag: "Quota",
        quotaBlockedCount: 2,
        resetAtMs: NOW + 3_600_000,
        blocked: [
          { nodeId: "a", message: "rate limit exceeded — retry after 600 seconds" },
          { nodeId: "b", message: "rate limit exceeded — retry after 120 seconds" },
        ],
      },
      seam,
      NOW,
    );
    expect(wakeAt).toBe(NOW + 120_000);
  });

  test("falls back to the scheduler's aggregate reset when no message carried one", () => {
    expect(resolveQuotaWakeAt({ _tag: "Quota", quotaBlockedCount: 1, resetAtMs: NOW + 5_000 }, seam, NOW)).toBe(
      NOW + 5_000,
    );
  });

  test("a park nobody gave a deadline for gets none", () => {
    expect(resolveQuotaWakeAt({ _tag: "Quota", quotaBlockedCount: 1 }, seam, NOW)).toBeNull();
    expect(
      resolveQuotaWakeAt(
        {
          _tag: "Quota",
          quotaBlockedCount: 1,
          blocked: [{ nodeId: "a", message: "you are out of usage credits" }],
        },
        seam,
        NOW,
      ),
    ).toBeNull();
  });

  test("a deadline that has already elapsed makes the park due now, not deadline-less", () => {
    // The provider named a reset time and it has passed by the time the park is
    // written. A deadline-less park waits for an operator, so dropping the
    // elapsed one would strand a run that is in fact ready to go.
    expect(resolveQuotaWakeAt({ _tag: "Quota", quotaBlockedCount: 1, resetAtMs: NOW - 1 }, seam, NOW)).toBe(NOW);
    expect(
      resolveQuotaWakeAt(
        {
          _tag: "Quota",
          quotaBlockedCount: 1,
          blocked: [{ nodeId: "a", message: "rate limit exceeded", resetAtMs: NOW - 30_000 }],
        },
        seam,
        NOW,
      ),
    ).toBe(NOW);
  });
});

describe("the engine's park / retry / fail decision", () => {
  const quotaAttempt = () =>
    attemptRowFor(
      "You've hit your usage limit for Claude. Your limit will reset at 4pm (America/New_York).",
      "claude",
      "claude-code",
    );
  const transientAttempt = { state: "failed", errorJson: JSON.stringify({ code: "AGENT_FAILED", message: "boom" }) };
  const fatalAttempt = {
    state: "failed",
    errorJson: JSON.stringify({ code: "AGENT_CONFIG_INVALID", message: "LLM not set" }),
  };

  test("this is the decision the engine makes, not just the deadline it wakes on", () => {
    // Newest first, exactly as `listAttempts` returns them.
    expect(resolveFailedAttemptsDisposition([quotaAttempt()], { retries: 0, nowMs: NOW })).toMatchObject({
      action: "park",
      reason: "quota",
    });
    expect(resolveFailedAttemptsDisposition([transientAttempt], { retries: 2, nowMs: NOW })).toMatchObject({
      action: "retry",
    });
    expect(
      resolveFailedAttemptsDisposition([transientAttempt, transientAttempt, transientAttempt], {
        retries: 2,
        nowMs: NOW,
      }),
    ).toMatchObject({ action: "fail", reason: "budget-exhausted" });
    expect(resolveFailedAttemptsDisposition([fatalAttempt], { retries: 5, nowMs: NOW })).toMatchObject({
      action: "fail",
      reason: "non-retryable",
    });
  });

  test("a quota park spends no retry, so the budget survives the provider reset", () => {
    // Two quota failures and one transient one, against a budget of one retry:
    // only the transient failure counted, so the node still retries.
    expect(
      resolveFailedAttemptsDisposition([transientAttempt, quotaAttempt(), quotaAttempt()], {
        retries: 1,
        nowMs: NOW,
      }),
    ).toMatchObject({ action: "retry" });
  });

  test("an earlier fatal failure is terminal even when the newest one is retryable", () => {
    expect(
      resolveFailedAttemptsDisposition([transientAttempt, fatalAttempt], { retries: 5, nowMs: NOW }),
    ).toMatchObject({ action: "fail", reason: "non-retryable" });
  });

  test("a host that replaces classifyError changes what the engine does, not only when it wakes", () => {
    // The failure the shipping classifier calls transient. A host that knows
    // this provider text is hopeless makes the engine fail it instead, and a
    // host that knows it is a disguised quota limit makes the engine park.
    const failing = resolveFailedAttemptsDisposition([transientAttempt], {
      retries: 5,
      nowMs: NOW,
      classifiers: {
        classifyError: () => ({ kind: "fatal", providerFamily: "unknown", code: "HOST_KNOWS_BETTER" }),
        resolveRetry: defaultWaitWakeClassifiers.resolveRetry,
      },
    });
    expect(failing).toMatchObject({ action: "fail", reason: "non-retryable" });

    const parking = resolveFailedAttemptsDisposition([transientAttempt], {
      retries: 5,
      nowMs: NOW,
      classifiers: {
        classifyError: () => ({ kind: "quota", providerFamily: "unknown", wakeAt: NOW + 60_000 }),
        resolveRetry: defaultWaitWakeClassifiers.resolveRetry,
      },
    });
    expect(parking).toEqual({ action: "park", reason: "quota", wakeAt: NOW + 60_000 });

    // And the default pair, on the same row, retries.
    expect(resolveFailedAttemptsDisposition([transientAttempt], { retries: 5, nowMs: NOW })).toMatchObject({
      action: "retry",
    });
  });
});

describe("family coverage", () => {
  test("every family the defaults know about is exercised above", () => {
    expect(knownProviderFamilies()).toEqual(["anthropic", "openai", "google", "xai"]);
  });
});

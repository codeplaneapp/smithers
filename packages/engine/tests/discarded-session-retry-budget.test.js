import { describe, expect, test } from "bun:test";
import { isDiscardedSessionAttempt } from "../src/effect/isDiscardedSessionAttempt.js";
import { stampDurableRetryState } from "../src/effect/retry-state.js";
import { classifySessionLoss } from "@smthrs/agents/BaseCliAgent/BaseCliAgent";

/** @param {Record<string, unknown>} details */
function sessionLostAttempt(details = { discardResumeSession: true, command: "claude" }) {
  return {
    state: "failed",
    errorJson: JSON.stringify({
      code: "AGENT_SESSION_LOST",
      message: "conversation no longer exists",
      details,
    }),
    metaJson: null,
  };
}

function quotaAttempt() {
  return {
    state: "failed",
    errorJson: JSON.stringify({ code: "AGENT_QUOTA_EXCEEDED", message: "limit" }),
    metaJson: null,
  };
}

function realFailureAttempt() {
  return {
    state: "failed",
    errorJson: JSON.stringify({ code: "AGENT_CLI_ERROR", message: "boom" }),
    metaJson: null,
  };
}

describe("isDiscardedSessionAttempt", () => {
  test("a dead resume session is bookkeeping, not a consumed retry", () => {
    expect(isDiscardedSessionAttempt(sessionLostAttempt())).toBe(true);
  });

  test("a session that broke on a FRESH start still consumes the budget", () => {
    expect(
      isDiscardedSessionAttempt(
        sessionLostAttempt({ discardResumeSession: true, freshSessionFailure: true, command: "kimi" }),
      ),
    ).toBe(false);
  });

  test("reads the flag from attempt meta when the error carries no details", () => {
    expect(isDiscardedSessionAttempt({ state: "failed", errorJson: null, metaJson: JSON.stringify({ discardResumeSession: true }) })).toBe(true);
    expect(
      isDiscardedSessionAttempt({
        state: "failed",
        errorJson: null,
        metaJson: JSON.stringify({ discardResumeSession: true, freshSessionFailure: true }),
      }),
    ).toBe(false);
  });

  test("ordinary, quota, and malformed failures are untouched", () => {
    expect(isDiscardedSessionAttempt(realFailureAttempt())).toBe(false);
    expect(isDiscardedSessionAttempt(quotaAttempt())).toBe(false);
    expect(isDiscardedSessionAttempt({ state: "failed", errorJson: "{not json", metaJson: "{also not json" })).toBe(false);
    expect(isDiscardedSessionAttempt(null)).toBe(false);
    expect(isDiscardedSessionAttempt(undefined)).toBe(false);
  });
});

describe("stampDurableRetryState budget accounting", () => {
  const descriptor = { retries: 3 };
  const error = { code: "AGENT_CLI_ERROR", message: "boom" };

  /** @param {ReadonlyArray<unknown>} attempts */
  function stamp(attempts) {
    const attemptMeta = { kind: "agent" };
    return stampDurableRetryState({ attemptMeta, attempts, descriptor, error, failedAtMs: 1_000 });
  }

  test("dead-session attempts do not advance the retry rung", () => {
    const withSessionLosses = stamp([sessionLostAttempt(), sessionLostAttempt(), realFailureAttempt()]);
    const withRealFailureOnly = stamp([realFailureAttempt()]);
    expect(withSessionLosses?.failureCount).toBe(withRealFailureOnly?.failureCount);
    expect(withSessionLosses?.failureCount).toBe(2);
  });

  test("a budget spent only on dead sessions and quota never exhausts", () => {
    // Four bookkeeping failures against a retries=3 budget: still retryable.
    const state = stamp([sessionLostAttempt(), quotaAttempt(), sessionLostAttempt(), quotaAttempt()]);
    expect(state).not.toBeNull();
    expect(state?.failureCount).toBe(1);
  });

  test("real failures still exhaust the budget", () => {
    expect(stamp([realFailureAttempt(), realFailureAttempt(), realFailureAttempt()])).toBeNull();
  });
});

describe("classifySessionLoss marks fresh-session failures", () => {
  const stderr = "No conversation found with session ID: 68b187d0-a325-4384-a248-b2a0e6edbd90";

  test("a resumed claude session is retryable bookkeeping", () => {
    const error = classifySessionLoss("claude", stderr, stderr, true);
    expect(error?.details?.discardResumeSession).toBe(true);
    expect(error?.details?.freshSessionFailure).toBe(false);
    expect(isDiscardedSessionAttempt({ state: "failed", errorJson: JSON.stringify(error), metaJson: null })).toBe(true);
  });

  test("a fresh claude session failure consumes the budget so the chain fails over", () => {
    const error = classifySessionLoss("claude", stderr, stderr, false);
    expect(error?.details?.freshSessionFailure).toBe(true);
    expect(isDiscardedSessionAttempt({ state: "failed", errorJson: JSON.stringify(error), metaJson: null })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { __humanRequestInternals, waitForHumanAnswer } from "../src/human-requests.js";

const { defaultPollSleep } = __humanRequestInternals;

function fakeAbortSignal() {
  const added = [];
  const removed = [];
  return {
    signal: {
      aborted: false,
      addEventListener(type, fn, opts) {
        added.push({ type, fn, opts });
      },
      removeEventListener(type, fn) {
        removed.push({ type, fn });
      },
    },
    added,
    removed,
  };
}

describe("defaultPollSleep", () => {
  test("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await defaultPollSleep(60_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("an abort mid-sleep resolves early instead of waiting out the timer", async () => {
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 10);
    await defaultPollSleep(60_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("invoking the registered abort listener resolves the sleep", async () => {
    const { signal, added } = fakeAbortSignal();
    const sleep = defaultPollSleep(60_000, signal);
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe("abort");
    expect(added[0].opts).toEqual({ once: true });
    added[0].fn();
    await sleep;
  });

  test("a completed timer removes the abort listener it registered", async () => {
    const { signal, added, removed } = fakeAbortSignal();
    await defaultPollSleep(5, signal);
    expect(removed).toHaveLength(1);
    expect(removed[0].type).toBe("abort");
    expect(removed[0].fn).toBe(added[0].fn);
  });

  test("resolves without a signal", async () => {
    await defaultPollSleep(1);
  });
});

describe("waitForHumanAnswer poll interval bounds", () => {
  function answeringAdapter() {
    let polls = 0;
    return {
      expireStaleHumanRequests: async () => {},
      getHumanRequest: async (requestId) => {
        polls += 1;
        return {
          requestId,
          status: polls > 1 ? "answered" : "pending",
          responseJson: polls > 1 ? JSON.stringify({ ok: true }) : null,
          answeredBy: polls > 1 ? "operator" : null,
        };
      },
    };
  }

  test("clamps a too-small pollIntervalMs up to 250ms", async () => {
    const sleeps = [];
    const outcome = await waitForHumanAnswer(answeringAdapter(), "req-1", {
      pollIntervalMs: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(outcome.status).toBe("answered");
    expect(sleeps).toEqual([250]);
  });

  test("passes a reasonable pollIntervalMs through unchanged", async () => {
    const sleeps = [];
    await waitForHumanAnswer(answeringAdapter(), "req-2", {
      pollIntervalMs: 5_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([5_000]);
  });

  test("defaults the poll interval to 3000ms when unset", async () => {
    const sleeps = [];
    await waitForHumanAnswer(answeringAdapter(), "req-3", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([3_000]);
  });
});

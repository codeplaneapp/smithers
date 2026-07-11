import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeGitHubClient } from "../src/github/GitHubClient.js";
import { makeLinearClient } from "../src/linear/LinearClient.js";
import { makeTelegramClient } from "../src/telegram/TelegramClient.js";

/**
 * Run an integration request against a real server that never responds, then
 * interrupt its Effect runtime and prove the underlying HTTP connection sees
 * cancellation promptly.
 *
 * @param {(origin: string) => import("effect").Effect.Effect<unknown, unknown>} makeEffect
 */
async function expectInterruptionToAbortFetch(makeEffect) {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      markStarted();
      await new Promise((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            markAborted();
            resolve();
          },
          { once: true },
        );
      });
      return new Response("cancelled", { status: 499 });
    },
  });
  const controller = new AbortController();
  try {
    const pending = Effect.runPromise(
      makeEffect(`http://127.0.0.1:${server.port}`),
      { signal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("test interruption", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    await Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server did not observe abort")), 1_000)),
    ]);
  } finally {
    server.stop(true);
  }
}

describe("integration HTTP cancellation", () => {
  test("interrupts Telegram fetch and response work", () =>
    expectInterruptionToAbortFetch((origin) =>
      makeTelegramClient({ botToken: "123:test-token", apiBaseUrl: origin }).call("getMe"),
    ));

  test("interrupts Linear fetch and retry work", () =>
    expectInterruptionToAbortFetch((origin) =>
      makeLinearClient({ apiKey: "linear-key", apiBaseUrl: origin }).query("query Viewer { viewer { id } }"),
    ));

  test("interrupts GitHub fetch, body read, and pagination work", () =>
    expectInterruptionToAbortFetch((origin) =>
      makeGitHubClient({ token: "github-key", apiBaseUrl: origin }).request("GET", "/user"),
    ));
});

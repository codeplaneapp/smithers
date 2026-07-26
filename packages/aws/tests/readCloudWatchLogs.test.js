import { describe, expect, test } from "bun:test";
import { readCloudWatchLogs } from "../src/readCloudWatchLogs.js";

describe("readCloudWatchLogs", () => {
  test("returns empty string when logs/group/stream are missing", async () => {
    expect(await readCloudWatchLogs({ logs: undefined, logGroupName: "g", logStreamName: "s" })).toBe("");
    const logs = { getLogEvents: async () => ({ events: [{ message: "x" }] }) };
    expect(await readCloudWatchLogs({ logs, logGroupName: undefined, logStreamName: "s" })).toBe("");
    expect(await readCloudWatchLogs({ logs, logGroupName: "g", logStreamName: undefined })).toBe("");
  });

  test("concatenates event messages", async () => {
    const logs = { getLogEvents: async () => ({ events: [{ message: "a" }, { message: "b" }, {}] }) };
    expect(await readCloudWatchLogs({ logs, logGroupName: "g", logStreamName: "s" })).toBe("ab");
  });

  test("truncates output to maxOutputBytes with a suffix", async () => {
    const logs = { getLogEvents: async () => ({ events: [{ message: "0123456789" }] }) };
    const out = await readCloudWatchLogs({ logs, logGroupName: "g", logStreamName: "s", maxOutputBytes: 4 });
    expect(out).toBe("0123… [truncated 6 chars]");
  });

  test("resolves to empty string when getLogEvents throws", async () => {
    const logs = {
      getLogEvents: async () => {
        throw new Error("throttled");
      },
    };
    expect(await readCloudWatchLogs({ logs, logGroupName: "g", logStreamName: "s" })).toBe("");
  });

  test("forwards cancellation to a pending GetLogEvents request", async () => {
    const controller = new AbortController();
    let logSignal;
    const logs = {
      getLogEvents: (_input, handlerOptions) => {
        logSignal = handlerOptions?.abortSignal;
        return new Promise((_, reject) => {
          logSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      },
    };
    const pending = readCloudWatchLogs({ logs, logGroupName: "g", logStreamName: "s", signal: controller.signal });
    expect(logSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

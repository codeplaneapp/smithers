import { expect, test } from "bun:test";
import { runInitCeremony } from "../src/initCeremony.js";

// A cancelled agent question used to `process.exit(0)` silently: wrapping
// scripts read the cancelled run as success. It must print a notice and exit
// non-zero (130, the conventional Ctrl-C code).
test("runInitCeremony exits 130 with a notice when the agent question is cancelled", async () => {
  const errs = [];
  const originalWrite = process.stderr.write;
  const originalExit = process.exit;
  process.stderr.write = (chunk) => {
    errs.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  let exitCode;
  // @ts-expect-error test stub throws instead of terminating the runner
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__process_exit__");
  };
  try {
    await runInitCeremony({
      env: {},
      detections: [],
      selectAgent: async () => "cancelled",
    });
    throw new Error("expected runInitCeremony to exit on cancel");
  } catch (err) {
    if (err.message !== "__process_exit__") throw err;
  } finally {
    process.stderr.write = originalWrite;
    process.exit = originalExit;
  }
  expect(exitCode).toBe(130);
  expect(errs.join("")).toContain("init cancelled");
});

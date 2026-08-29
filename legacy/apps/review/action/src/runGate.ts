#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { gateEvent } from "./gateEvent";

/**
 * Composite step 1 entrypoint. Reads the event payload, decides run vs skip,
 * and writes `should-run`/`pr-number`/`head-sha` to GITHUB_OUTPUT so later
 * steps can gate on it. Skips print `::notice::` so the reason is visible in
 * the workflow run summary instead of failing the job.
 */
function setOutput(key: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `${key}=${value}\n`);
}

const eventName = process.env.GITHUB_EVENT_NAME ?? "";
const eventPath = process.env.GITHUB_EVENT_PATH ?? "";

let payload: unknown = {};
if (eventPath) {
  try {
    payload = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
  } catch (error) {
    console.log(`::notice::smithers review skipped: could not read GITHUB_EVENT_PATH (${(error as Error).message})`);
    setOutput("should-run", "false");
    process.exit(0);
  }
}

const decision = gateEvent({ eventName, payload });
if (decision.run) {
  setOutput("should-run", "true");
  setOutput("pr-number", String(decision.prNumber));
  setOutput("event-name", decision.eventName);
  if (decision.headSha) setOutput("head-sha", decision.headSha);
  console.log(`smithers review: ${decision.eventName} #${decision.prNumber} eligible — continuing`);
} else {
  setOutput("should-run", "false");
  console.log(`::notice::smithers review skipped: ${decision.reason}`);
}

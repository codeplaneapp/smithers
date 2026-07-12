#!/usr/bin/env bun
import { appendFileSync, closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { gateEvent } from "./gateEvent";
import { eventCanPublish, reviewCredentialPolicy } from "./reviewTrustPolicy";

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

function readEvent(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 5 * 1024 * 1024) throw new Error("event is empty or oversized");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.dev !== before.dev || after.ino !== before.ino) throw new Error("event changed while being read");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("event is not valid UTF-8"); }
    return JSON.parse(text) as unknown;
  } finally { closeSync(fd); }
}

function safe(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/@(?!\u200b)/g, "@\u200b")
    .slice(0, 200);
}

const eventName = process.env.GITHUB_EVENT_NAME ?? "";
const eventPath = process.env.GITHUB_EVENT_PATH ?? "";

let payload: unknown = {};
if (eventPath) {
  try {
    payload = readEvent(eventPath);
  } catch (error) {
    console.log(`::notice::smithers review skipped: could not read GITHUB_EVENT_PATH (${safe(error)})`);
    setOutput("should-run", "false");
    process.exit(0);
  }
}

const decision = gateEvent({ eventName, payload });
if (decision.run) {
  const trust = reviewCredentialPolicy();
  setOutput("should-run", "true");
  setOutput("pr-number", String(decision.prNumber));
  setOutput("event-name", decision.eventName);
  if (decision.headSha) setOutput("head-sha", decision.headSha);
  if (decision.baseSha) setOutput("base-sha", decision.baseSha);
  setOutput("subscription-eligible", trust.subscriptionEligible ? "true" : "false");
  setOutput("can-publish", eventCanPublish(eventName, payload) ? "true" : "false");
  console.log(
    `smithers review: ${decision.eventName} #${decision.prNumber} eligible — ${trust.subscriptionEligible ? "trusted subscription" : "metered proxy"} (${trust.reason})`,
  );
} else {
  setOutput("should-run", "false");
  console.log(`::notice::smithers review skipped: ${safe(decision.reason)}`);
}

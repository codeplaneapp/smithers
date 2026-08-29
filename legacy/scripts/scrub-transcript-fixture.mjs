#!/usr/bin/env node
/** Scrub recorded CLI transcript fixtures without changing their event shape. */
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("usage: scrub-transcript-fixture.mjs <fixture.jsonl> [...]");
// Tool-call ids must stay *distinct* per original id: started/completed event
// correlation keys on them, so collapsing every id to one literal would
// destroy exactly what the fixtures exist to exercise. Map each original to a
// deterministic placeholder in first-appearance order (per file).
function createToolIdScrubber() {
  const placeholders = new Map();
  return (original) => {
    let placeholder = placeholders.get(original);
    if (!placeholder) {
      placeholder = `tool-fixture-${placeholders.size + 1}`;
      placeholders.set(original, placeholder);
    }
    return placeholder;
  };
}
function scrubString(value, scrubToolId) {
  return value
    .replaceAll("/Users/williamcory/flows/", "/repo/")
    .replaceAll("/Users/williamcory/smithers/", "/repo/")
    .replace(/\/Users\/williamcory(?:\/[^\s"'`\\)]*)?/g, "/repo")
    .replace(/run-\d+/g, "run-fixture")
    .replace(/toolu_[A-Za-z0-9]+/g, scrubToolId)
    .replace(/tool_[A-Za-z0-9]+/g, scrubToolId)
    .replace(/session[_-]?[A-Za-z0-9-]+/gi, "session-fixture");
}
function scrub(value, scrubToolId) {
  if (typeof value === "string") return scrubString(value, scrubToolId);
  if (Array.isArray(value)) return value.map((child) => scrub(child, scrubToolId));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(timestampMs|timestamp|createdAt|updatedAt)$/i.test(key)) continue;
    result[key] = scrub(child, scrubToolId);
  }
  const action = result.event?.action;
  if (action && action.kind !== "file_change") {
    if (action.detail && typeof action.detail === "object") delete action.detail.input;
    delete result.event.message;
  }
  if (action?.kind === "command") {
    action.title = "[scrubbed command]";
    delete result.event.message;
  }
  if (result.event?.type === "started") {
    if (typeof result.event.resume === "string") result.event.resume = "session-fixture";
    if (result.event.detail && typeof result.event.detail === "object") {
      for (const key of ["sessionId", "threadId"])
        if (key in result.event.detail) result.event.detail[key] = "session-fixture";
    }
  }
  if (result.event?.type === "completed") {
    delete result.event.resume;
    delete result.event.answer;
  }
  return result;
}
for (const file of files) {
  const scrubToolId = createToolIdScrubber();
  const output = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.stringify(scrub(JSON.parse(line), scrubToolId)))
    .join("\n");
  writeFileSync(file, `${output}\n`);
}

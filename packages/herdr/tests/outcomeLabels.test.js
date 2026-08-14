import { describe, expect, test } from "bun:test";
import {
  openTabPane,
  OUTCOME_MARKERS,
  outcomeMarkerFor,
  stripOutcomeMarker,
  workspaceLabelMatches,
} from "../src/index.js";

describe("outcome-marker helpers", () => {
  test("OUTCOME_MARKERS maps each terminal kind to a distinct glyph and is frozen", () => {
    expect(OUTCOME_MARKERS.finished).toBe("✓");
    expect(OUTCOME_MARKERS.failed).toBe("✗");
    expect(OUTCOME_MARKERS.cancelled).toBe("◻");
    expect(Object.isFrozen(OUTCOME_MARKERS)).toBe(true);
  });

  test("outcomeMarkerFor resolves terminal kinds and is undefined otherwise", () => {
    expect(outcomeMarkerFor("finished")).toBe("✓");
    expect(outcomeMarkerFor("failed")).toBe("✗");
    expect(outcomeMarkerFor("cancelled")).toBe("◻");
    expect(outcomeMarkerFor("running")).toBeUndefined();
    expect(outcomeMarkerFor(/** @type {any} */ (undefined))).toBeUndefined();
  });

  test("stripOutcomeMarker removes exactly one leading marker+space, else returns unchanged", () => {
    expect(stripOutcomeMarker("✓ my-wf run-1")).toBe("my-wf run-1");
    expect(stripOutcomeMarker("✗ my-wf run-1")).toBe("my-wf run-1");
    expect(stripOutcomeMarker("◻ my-wf run-1")).toBe("my-wf run-1");
    // No marker: unchanged.
    expect(stripOutcomeMarker("my-wf run-1")).toBe("my-wf run-1");
    // Only ONE marker stripped (never double-strips).
    expect(stripOutcomeMarker("✓ ✗ my-wf run-1")).toBe("✗ my-wf run-1");
    // A leading non-marker glyph is left alone.
    expect(stripOutcomeMarker("★ my-wf run-1")).toBe("★ my-wf run-1");
    expect(stripOutcomeMarker(/** @type {any} */ (undefined))).toBeUndefined();
  });
});

describe("workspaceLabelMatches (outcome-tolerant exact identity)", () => {
  const target = "my-wf [smithers:v1:run-1783720000000-abcd]";
  const runId = "run-1783720000000-abcd";

  test("exact label matches", () => {
    expect(workspaceLabelMatches(target, target)).toBe(true);
  });

  test("an outcome-prefixed label still matches (finished / failed / cancelled)", () => {
    expect(workspaceLabelMatches(`✓ ${target}`, target)).toBe(true);
    expect(workspaceLabelMatches(`✗ ${target}`, target)).toBe(true);
    expect(workspaceLabelMatches(`◻ ${target}`, target)).toBe(true);
  });

  test("a workspace for a DIFFERENT run does not match", () => {
    const otherLabel = "my-wf [smithers:v1:run-1783720000000-zzzz]";
    expect(workspaceLabelMatches(otherLabel, target)).toBe(false);
    expect(workspaceLabelMatches(`✓ ${otherLabel}`, target)).toBe(false);
  });

  test("a matching run marker under another label never grants ownership", () => {
    expect(workspaceLabelMatches(`operator notes [smithers:v1:${runId}]`, target)).toBe(false);
    expect(workspaceLabelMatches(`✓ operator notes [smithers:v1:${runId}]`, target)).toBe(false);
  });

  test("non-string candidate labels are rejected", () => {
    expect(workspaceLabelMatches(/** @type {any} */ (undefined), target)).toBe(false);
    expect(workspaceLabelMatches(/** @type {any} */ (null), target)).toBe(false);
  });
});

describe("openTabPane export", () => {
  test("is a function (surface placement helper is re-exported)", () => {
    expect(typeof openTabPane).toBe("function");
  });
});

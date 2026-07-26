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

describe("workspaceLabelMatches (prefix-tolerant find-or-create)", () => {
  const target = "my-wf run-1783720000000-abcd";
  const runId = "run-1783720000000-abcd";

  test("exact label matches", () => {
    expect(workspaceLabelMatches(target, target, runId)).toBe(true);
  });

  test("an outcome-prefixed label still matches (finished / failed / cancelled)", () => {
    expect(workspaceLabelMatches(`✓ ${target}`, target, runId)).toBe(true);
    expect(workspaceLabelMatches(`✗ ${target}`, target, runId)).toBe(true);
    expect(workspaceLabelMatches(`◻ ${target}`, target, runId)).toBe(true);
  });

  test("a workspace for a DIFFERENT run does not match", () => {
    const otherLabel = "my-wf run-1783720000000-zzzz";
    expect(workspaceLabelMatches(otherLabel, target, runId)).toBe(false);
    expect(workspaceLabelMatches(`✓ ${otherLabel}`, target, runId)).toBe(false);
  });

  test("run-id token match is collision-safe between run-1 and run-12", () => {
    // A workspace labeled with the longer run id must NOT match the shorter target.
    expect(workspaceLabelMatches("wf run-12", "wf run-1", "run-1")).toBe(false);
    // The correct workspace matches by its trailing run-id token, even renamed.
    expect(workspaceLabelMatches("✓ wf run-1", "wf run-1", "run-1")).toBe(true);
  });

  test("non-string candidate labels are rejected", () => {
    expect(workspaceLabelMatches(/** @type {any} */ (undefined), target, runId)).toBe(false);
    expect(workspaceLabelMatches(/** @type {any} */ (null), target, runId)).toBe(false);
  });
});

describe("openTabPane export", () => {
  test("is a function (surface placement helper is re-exported)", () => {
    expect(typeof openTabPane).toBe("function");
  });
});

/** @jsxImportSource @opentui/react */
import { it, expect } from "bun:test";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import { RunHeaderView } from "../src/Header.tsx";
import type { RunHeaderData } from "../src/headerUtils.ts";

/**
 * Terminal rendering tests for the REAL run header (`RunHeaderView`), the same
 * presentational component the connected `Header` mounts. CI-safe: props-only,
 * no gateway / clock / agent.
 */

function data(overrides: Partial<RunHeaderData> = {}): RunHeaderData {
  return {
    status: "running",
    workflowKey: "deploy",
    runId: "run-abc123",
    model: "claude-opus-4-8",
    elapsedMs: 154_000,
    live: true,
    ...overrides,
  };
}

describeHeadlessRender("RunHeaderView – terminal rendering (CI-safe, no gateway)", () => {
  it("renders workflow, run id, model, elapsed, and the live indicator", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <RunHeaderView data={data()} compact={false} />,
      { width: 120, height: 6 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("deploy");
    expect(f).toContain("run-abc123");
    expect(f).toContain("claude-opus-4-8");
    expect(f).toContain("02:34");
    expect(f).toContain("[live]");
    renderer.destroy();
  });

  it("shows [paused] for a waiting run", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <RunHeaderView data={data({ status: "waiting-approval", live: false })} compact={false} />,
      { width: 120, height: 6 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[paused]");
    renderer.destroy();
  });

  it("omits the model segment when no model is available (never fabricated)", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <RunHeaderView data={data({ model: undefined })} compact={false} />,
      { width: 120, height: 6 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).not.toContain("claude-opus-4-8");
    // workflow + elapsed still render.
    expect(f).toContain("deploy");
    expect(f).toContain("02:34");
    renderer.destroy();
  });

  it("compact mode shows id + status + live without the wide segments", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <RunHeaderView data={data()} compact={true} />,
      { width: 60, height: 6 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("run-abc123");
    expect(f).toContain("[live]");
    renderer.destroy();
  });
});

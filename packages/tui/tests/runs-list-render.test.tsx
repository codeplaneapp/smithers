/** @jsxImportSource @opentui/react */
import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { resetRunsForIdentityChange, setRunsListRows } from "@smithers-orchestrator/ui-core";
import { RunsListView } from "../src/modes/RunsListMode.tsx";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";

afterEach(() => resetRunsForIdentityChange());

describeHeadlessRender("RunsListMode – terminal rendering", () => {
  it("shows hydration state before the live roster arrives", async () => {
    resetRunsForIdentityChange();
    const { captureCharFrame, renderer } = await renderForTest(<RunsListView onSelectRun={() => {}} />, {
      width: 120,
      height: 24,
    });

    expect(captureCharFrame()).toContain("Loading runs");
    renderer.destroy();
  });

  it("renders the hydrated empty state", async () => {
    resetRunsForIdentityChange();
    act(() => setRunsListRows([]));
    const { captureCharFrame, renderer } = await renderForTest(<RunsListView onSelectRun={() => {}} />, {
      width: 120,
      height: 24,
    });

    expect(captureCharFrame()).toContain("No runs yet");
    renderer.destroy();
  });
});

/** @jsxImportSource @opentui/react */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { nodeGlyph, nodeGlyphColor, ALL_TABS, type TabId } from "../src/modes/treeUtils.ts";

/**
 * Terminal rendering tests for TREE mode components.
 * CI-safe: no gateway, no agent CLI, no browser.
 * Uses @opentui/react testRender (headless OpenTUI renderer).
 */

// Minimal tab bar identical to the one inside TreeMode
function TabBar({ active }: { active: TabId }) {
  return (
    <box width="100%" height={1} flexDirection="row">
      {ALL_TABS.map((t) => (
        <text key={t} fg={t === active ? "#ffffff" : "#555555"} bg={t === active ? "#333333" : undefined}>
          {` ${t} `}
        </text>
      ))}
    </box>
  );
}

// Minimal interactive component: renders a 2-node tree + tab bar.
// Accepts 1-5 keystrokes to switch tabs.
function TestTreeView() {
  const [activeTab, setActiveTab] = useState<TabId>("output");

  useKeyboard((e) => {
    if (e.name === "1") setActiveTab("output");
    else if (e.name === "2") setActiveTab("logs");
    else if (e.name === "3") setActiveTab("tools");
    else if (e.name === "4") setActiveTab("diff");
    else if (e.name === "5") setActiveTab("props");
  });

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1} flexDirection="row">
        <text fg={nodeGlyphColor("done")}>{nodeGlyph("done")}</text>
        <text fg="#cccccc">{" done-node"}</text>
      </box>
      <box width="100%" height={1} flexDirection="row">
        <text fg={nodeGlyphColor("running")}>{nodeGlyph("running")}</text>
        <text fg="#cccccc">{" running-node"}</text>
      </box>
      <box width="100%" height={1} flexDirection="row">
        <text fg={nodeGlyphColor("failed")}>{nodeGlyph("failed")}</text>
        <text fg="#cccccc">{" failed-node"}</text>
      </box>
      <TabBar active={activeTab} />
      <text fg="#888888">{`tab:${activeTab}`}</text>
    </box>
  );
}

describe("TreeMode – terminal rendering (CI-safe, no gateway)", () => {
  it("renders node status glyphs in the terminal frame", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestTreeView />,
      { width: 80, height: 24 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();

    expect(frame).toContain(nodeGlyph("done"));       // ✓
    expect(frame).toContain(nodeGlyph("running"));    // ●
    expect(frame).toContain(nodeGlyph("failed"));     // ✗
    expect(frame).toContain("done-node");
    expect(frame).toContain("running-node");
    expect(frame).toContain("failed-node");

    renderer.destroy();
  });

  it("renders tab bar with correct initial active tab", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestTreeView />,
      { width: 80, height: 24 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();

    // All 5 tab labels should appear
    for (const tab of ALL_TABS) {
      expect(frame).toContain(tab);
    }
    // Initial tab is output
    expect(frame).toContain("tab:output");

    renderer.destroy();
  });

  it("switches tabs via 1-5 keystrokes", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await testRender(<TestTreeView />, { width: 80, height: 24 });
    await waitForVisualIdle();

    expect(captureCharFrame()).toContain("tab:output");

    act(() => { mockInput.pressKey("2"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("tab:logs");

    act(() => { mockInput.pressKey("5"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("tab:props");

    act(() => { mockInput.pressKey("1"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("tab:output");

    renderer.destroy();
  });

  it("maps all 5 tab keys to correct tabs", async () => {
    const tabMap: Array<[string, TabId]> = [
      ["1", "output"],
      ["2", "logs"],
      ["3", "tools"],
      ["4", "diff"],
      ["5", "props"],
    ];

    for (const [key, expectedTab] of tabMap) {
      const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
        await testRender(<TestTreeView />, { width: 80, height: 24 });
      await waitForVisualIdle();

      act(() => { mockInput.pressKey(key); });
      await flush();
      await waitForVisualIdle();
      expect(captureCharFrame()).toContain(`tab:${expectedTab}`);

      renderer.destroy();
    }
  });
});

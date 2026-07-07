/** @jsxImportSource @opentui/react */
import { it, expect } from "bun:test";
import { act } from "react";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import { ErrorBoundary } from "../src/ErrorBoundary.tsx";
import { RendererProvider, useRenderer } from "../src/RendererContext.tsx";
import type { CliRenderer } from "@opentui/core";

/**
 * The crash screen (`ErrorBoundary` + its `ErrorFallback`) is what keeps a
 * render error from wedging the terminal: it renders a quit-able fallback whose
 * `useKeyboard` stays live so q / Ctrl-C route through `onExit`. Driven here with
 * the REAL OpenTUI renderer (no gateway).
 */

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

function UsesRenderer() {
  const renderer = useRenderer();
  // Touch the value so the success branch of useRenderer executes and returns.
  return <text>{`renderer:${typeof renderer.destroy}`}</text>;
}

describeHeadlessRender("ErrorBoundary crash screen", () => {
  it("renders children when nothing throws", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <ErrorBoundary onExit={() => {}}>
        <box>
          <text>healthy-child</text>
        </box>
      </ErrorBoundary>,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("healthy-child");
    renderer.destroy();
  });

  it("shows the crash fallback and quits on q and Ctrl-C", async () => {
    const exits: number[] = [];
    const { waitForVisualIdle, captureCharFrame, mockInput, flush, renderer } = await renderForTest(
      <ErrorBoundary onExit={(code) => exits.push(code)}>
        <Boom message="kaboom-render" />
      </ErrorBoundary>,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("Error: kaboom-render");
    expect(f).toContain("[q] or Ctrl-C to quit");

    act(() => { mockInput.pressKey("q"); });
    await flush();
    expect(exits).toEqual([1]);

    // Ctrl-C also routes through onExit.
    act(() => { mockInput.pressKey("\x03"); });
    await flush();
    expect(exits).toEqual([1, 1]);
    renderer.destroy();
  });

  it("ignores unrelated keys and Ctrl/Meta chords on the crash screen", async () => {
    const exits: number[] = [];
    const { waitForVisualIdle, mockInput, flush, renderer } = await renderForTest(
      <ErrorBoundary onExit={(code) => exits.push(code)}>
        <Boom message="boom2" />
      </ErrorBoundary>,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    act(() => { mockInput.pressKey("j"); });
    await flush();
    expect(exits).toEqual([]);
    renderer.destroy();
  });

  it("catches useRenderer's throw when there is no RendererProvider", async () => {
    // useRenderer must throw a clear error outside a provider; the boundary turns
    // that into the crash screen instead of a wedged terminal.
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <ErrorBoundary onExit={() => {}}>
        <UsesRenderer />
      </ErrorBoundary>,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("useRenderer must be used inside <RendererProvider>");
    renderer.destroy();
  });
});

describeHeadlessRender("RendererProvider / useRenderer success path", () => {
  it("returns the provided renderer to consumers", async () => {
    let captured: CliRenderer | null = null;
    function Capture({ children }: { children: React.ReactNode }) {
      return <>{children}</>;
    }
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <Capture>
        <RendererProviderBridge onRenderer={(r) => (captured = r)} />
      </Capture>,
      { width: 80, height: 12 },
    );
    await waitForVisualIdle();
    // The bridge feeds the live OpenTUI renderer into our RendererProvider and a
    // consumer reads it back, exercising useRenderer's non-throwing return.
    expect(captureCharFrame()).toContain("renderer:function");
    expect(captured).not.toBeNull();
    renderer.destroy();
  });
});

// Bridge: reads OpenTUI's own renderer and republishes it through our context so
// useRenderer's success branch runs under a real provider.
import { useRenderer as useOpenTuiRenderer } from "@opentui/react";
function RendererProviderBridge({ onRenderer }: { onRenderer: (r: CliRenderer) => void }) {
  const renderer = useOpenTuiRenderer();
  onRenderer(renderer as unknown as CliRenderer);
  return (
    <RendererProvider value={renderer as unknown as CliRenderer}>
      <UsesRenderer />
    </RendererProvider>
  );
}

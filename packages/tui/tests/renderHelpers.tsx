/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { act } from "react";
import { describe } from "bun:test";
import { testRender } from "@opentui/react/test-utils";

type TestRenderResult = Awaited<ReturnType<typeof testRender>>;
type TestRenderOptions = Parameters<typeof testRender>[1];

// Bun 1.3.13 can crash in OpenTUI's headless renderer on Windows during test
// teardown. Pure utility tests still run there; renderer coverage stays active
// on Linux/macOS until the upstream crash is fixed.
export const describeHeadlessRender = describe.skipIf(process.platform === "win32");

/**
 * Render a component with the headless OpenTUI test renderer, wrapping the
 * async mount + idle/flush steps in React's `act(...)`. The OpenTUI renderer
 * commits frames asynchronously, so the state updates it drives land outside
 * any test-controlled `act` scope and React warns ("An update to Root inside a
 * test was not wrapped in act(...)"). Funnelling every async settle point
 * through `act` here keeps the render tests warning-free without weakening what
 * they assert. Returned `waitForVisualIdle`/`flush` are likewise act-wrapped.
 */
export async function renderForTest(node: ReactNode, options: TestRenderOptions): Promise<TestRenderResult> {
  let result!: TestRenderResult;
  // Render AND drain the initial post-mount frames inside a single continuous
  // act scope. Splitting them lets a renderer timer fire a React state update in
  // the await gap between two act scopes, which is exactly what React warns
  // about. Settling here also means the first test-level waitForVisualIdle has
  // nothing pending, so it produces no out-of-act update either.
  await act(async () => {
    result = await testRender(node as Parameters<typeof testRender>[0], options);
    await result.waitForVisualIdle().catch(() => {});
  });

  const rawWaitForVisualIdle = result.waitForVisualIdle.bind(result);
  const rawFlush = result.flush.bind(result);

  // Tearing the renderer down drives a final round of React updates (effect
  // cleanups, root unmount) that otherwise land outside act. Wrap destroy so
  // renderer.destroy() in tests stays warning-free without each test changing.
  const renderer = result.renderer;
  const rawDestroy = renderer.destroy.bind(renderer);
  renderer.destroy = ((...args: Parameters<typeof rawDestroy>) => {
    let out: ReturnType<typeof rawDestroy>;
    act(() => {
      out = rawDestroy(...args);
    });
    return out!;
  }) as typeof renderer.destroy;

  return {
    ...result,
    waitForVisualIdle: async (...args: Parameters<typeof rawWaitForVisualIdle>) => {
      let out: Awaited<ReturnType<typeof rawWaitForVisualIdle>>;
      await act(async () => {
        out = await rawWaitForVisualIdle(...args);
      });
      return out!;
    },
    flush: async (...args: Parameters<typeof rawFlush>) => {
      let out: Awaited<ReturnType<typeof rawFlush>>;
      await act(async () => {
        out = await rawFlush(...args);
      });
      return out!;
    },
  };
}

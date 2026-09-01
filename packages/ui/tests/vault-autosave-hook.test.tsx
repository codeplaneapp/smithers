/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAutosaveDoc, type UseAutosaveDocResult } from "../src/vault/useAutosaveDoc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

describe("useAutosaveDoc", () => {
  test("drives the state machine from React with the real (default) timer", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe() {
      api = useAutosaveDoc({
        initialValue: "hello",
        debounceMs: 5,
        save: async (value) => {
          saved.push(value);
          return { mtimeMs: 42 };
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
    expect(api!.state).toBe("clean");
    expect(api!.statusText).toBe("");

    await act(async () => {
      api!.setValue("hello world");
    });
    expect(api!.state).toBe("dirty");
    expect(api!.statusText).toBe("Unsaved");

    // Poll the real (5ms-debounce) timer to completion instead of a fixed
    // sleep: a loaded CI runner (Windows especially) can exceed a hard 25ms
    // window, which flaked this test. Bounded so a genuine hang still fails.
    await act(async () => {
      const deadline = Date.now() + 2000;
      while (saved.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(saved).toEqual(["hello world"]);
    expect(api!.state).toBe("saved");
    expect(api!.statusText).toBe("Saved");
    expect(api!.mtimeMs).toBe(42);
  });

  test("exposes conflict state and discardExternal", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe() {
      api = useAutosaveDoc({
        initialValue: "mine",
        initialMtimeMs: 100,
        save: async (value) => {
          saved.push(value);
          return { mtimeMs: 250 };
        },
        readExternal: async () => ({ content: "someone else", mtimeMs: 200 }),
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
    await act(async () => {
      api!.setValue("mine edited");
    });
    await act(async () => {
      await api!.saveNow();
    });
    expect(api!.state).toBe("conflict");
    expect(api!.statusText).toBe("Changed on disk");
    expect(saved).toEqual([]);

    await act(async () => {
      await api!.discardExternal();
    });
    expect(api!.state).toBe("saved");
    expect(saved).toEqual(["mine edited"]);
  });

  test("survives StrictMode effect replay without losing a pending save", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe() {
      api = useAutosaveDoc({
        initialValue: "hello",
        debounceMs: 5,
        save: async (value) => {
          saved.push(value);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
    });
    await act(async () => {
      api!.setValue("strict edit");
      const deadline = Date.now() + 2000;
      while (saved.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });

    expect(api!.value).toBe("strict edit");
    expect(saved).toEqual(["strict edit"]);
  });

  test("uses a readExternal callback supplied after mount", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe({ checkExternal }: { checkExternal: boolean }) {
      api = useAutosaveDoc({
        initialValue: "mine",
        initialMtimeMs: 100,
        save: async (value) => {
          saved.push(value);
        },
        readExternal: checkExternal ? async () => ({ content: "changed elsewhere", mtimeMs: 200 }) : undefined,
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe checkExternal={false} />);
    });
    await act(async () => {
      api!.setValue("mine edited");
      root!.render(<Probe checkExternal />);
    });
    await act(async () => {
      await api!.saveNow();
    });

    expect(api!.state).toBe("conflict");
    expect(saved).toEqual([]);
  });

  test("recreates the machine when resetKey switches documents", async () => {
    let api: UseAutosaveDocResult | undefined;
    const savedA: string[] = [];
    const savedB: string[] = [];
    function Probe({ documentId, initialValue }: { documentId: "a" | "b"; initialValue: string }) {
      api = useAutosaveDoc({
        resetKey: documentId,
        initialValue,
        debounceMs: 60_000,
        save: async (value) => {
          (documentId === "a" ? savedA : savedB).push(value);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<Probe documentId="a" initialValue="document A" />));
    await act(async () => api!.setValue("document A draft"));
    await act(async () => root!.render(<Probe documentId="b" initialValue="document B" />));

    expect(api!.value).toBe("document B");
    await act(async () => api!.saveNow());
    expect(savedA).toEqual([]);
    expect(savedB).toEqual(["document B"]);
  });
});

/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
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
});

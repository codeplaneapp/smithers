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

/**
 * Poll a predicate across React commits instead of waiting a fixed duration.
 *
 * Each iteration yields to the real event loop (so a real debounce timer and
 * the save's own microtasks can run) and then lets `act` flush React, which is
 * what re-reads the hook's snapshot: an async `act` body never sees its own
 * renders, so the flush has to be the loop rather than something inside it.
 * The deadline is a hang guard, not a wait -- the assertions after the call
 * are what decide the test, and they run as soon as the transition lands.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
}

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

    // The debounce is a REAL timer here, so "dirty" is only true until it
    // fires: any `await` between the edit and the read races it. That is the
    // flake this test had -- a loaded runner stalls React's flush past 5ms and
    // the snapshot already reads "saved" (or "saving") by the assertion. A
    // synchronous `act` callback commits the edit's render before `act`
    // returns, so the read below happens on the same uninterrupted stack, on
    // which no timer callback can run. The callback returns `null` purely so
    // the call is typed as the thenable it always is at runtime; awaiting it
    // immediately after the read keeps React's "act was awaited" contract.
    const editCommitted = act(() => {
      api!.setValue("hello world");
      return null;
    });
    const edited = { state: api!.state, statusText: api!.statusText };
    await editCommitted;
    expect(edited).toEqual({ state: "dirty", statusText: "Unsaved" });

    // Nothing here forces the save: reaching "saved" proves the default
    // scheduler is live, since no `schedule` was injected. Wait on the
    // transition itself rather than on `saved.length`, which the writer pushes
    // before the machine has emitted anything.
    await waitFor(() => api!.state === "saved");
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
    });
    await waitFor(() => saved.length > 0);

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

  test("recreates the machine when resetKey switches documents, flushing the outgoing draft", async () => {
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
    // The outgoing machine held an unsaved draft well inside its 60s debounce.
    // Switching documents writes it, exactly as unmounting does; dropping it
    // would be silent data loss on every document switch.
    expect(savedA).toEqual(["document A draft"]);
    await act(async () => api!.saveNow());
    expect(savedB).toEqual(["document B"]);
  });

  test("a rapid a-to-b-to-c switch flushes every draft it passes through", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: Array<string> = [];
    function Probe({ documentId }: { documentId: "a" | "b" | "c" }) {
      api = useAutosaveDoc({
        resetKey: documentId,
        initialValue: `document ${documentId}`,
        debounceMs: 60_000,
        save: async (value) => {
          saved.push(`${documentId}:${value}`);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<Probe documentId="a" />));
    await act(async () => api!.setValue("draft a"));
    await act(async () => root!.render(<Probe documentId="b" />));
    await act(async () => api!.setValue("draft b"));
    await act(async () => root!.render(<Probe documentId="c" />));

    expect(saved).toEqual(["a:draft a", "b:draft b"]);
    expect(api!.value).toBe("document c");
  });

  test("switching documents under StrictMode still flushes exactly one draft", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe({ documentId }: { documentId: "a" | "b" }) {
      api = useAutosaveDoc({
        resetKey: documentId,
        initialValue: `document ${documentId}`,
        debounceMs: 60_000,
        save: async (value) => {
          saved.push(value);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <StrictMode>
          <Probe documentId="a" />
        </StrictMode>,
      )
    );
    await act(async () => api!.setValue("strict draft"));
    await act(async () =>
      root!.render(
        <StrictMode>
          <Probe documentId="b" />
        </StrictMode>,
      )
    );

    expect(saved).toEqual(["strict draft"]);
  });
});

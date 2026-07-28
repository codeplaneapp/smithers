import { describe, expect, test } from "bun:test";
import { autosaveStatusText, createAutosaveDoc, type AutosaveState } from "../src/vault/autosaveMachine";

/** Manual scheduler: the test decides when debounced saves fire. */
function manualScheduler() {
  const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule(fn: () => void, _ms: number) {
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    runAll() {
      for (const entry of queue.splice(0)) {
        if (!entry.cancelled) entry.fn();
      }
    },
    pending() {
      return queue.filter((entry) => !entry.cancelled).length;
    },
  };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createAutosaveDoc", () => {
  test("starts clean with the initial value", () => {
    const doc = createAutosaveDoc({ initialValue: "hello", save: async () => {} });
    expect(doc.getSnapshot()).toEqual({ value: "hello", state: "clean", mtimeMs: undefined });
  });

  test("an edit marks dirty and the debounce fires exactly one save with the latest value", async () => {
    const scheduler = manualScheduler();
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "a",
      schedule: scheduler.schedule,
      save: async (value) => {
        saved.push(value);
        return { mtimeMs: 42 };
      },
    });

    const states: AutosaveState[] = [];
    doc.subscribe(() => states.push(doc.getSnapshot().state));
    doc.setValue("ab");
    doc.setValue("abc");
    expect(doc.getSnapshot().state).toBe("dirty");
    expect(scheduler.pending()).toBe(1);

    scheduler.runAll();
    await flushMicrotasks();

    expect(saved).toEqual(["abc"]);
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().mtimeMs).toBe(42);
    // Both setValue calls emit (the value changes even while state stays dirty).
    expect(states).toEqual(["dirty", "dirty", "saving", "saved"]);
  });

  test("echoing the current text does not dirty a clean or saved document", () => {
    const scheduler = manualScheduler();
    const doc = createAutosaveDoc({ initialValue: "same", schedule: scheduler.schedule, save: async () => {} });
    doc.setValue("same");
    expect(doc.getSnapshot().state).toBe("clean");
    expect(scheduler.pending()).toBe(0);
  });

  test("saveNow skips the debounce", async () => {
    const scheduler = manualScheduler();
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "a",
      schedule: scheduler.schedule,
      save: async (value) => {
        saved.push(value);
      },
    });
    doc.setValue("b");
    await doc.saveNow();
    expect(saved).toEqual(["b"]);
    expect(doc.getSnapshot().state).toBe("saved");
    expect(scheduler.pending()).toBe(0);
  });

  test("a failed save returns to dirty and reschedules", async () => {
    const scheduler = manualScheduler();
    let calls = 0;
    const doc = createAutosaveDoc({
      initialValue: "a",
      schedule: scheduler.schedule,
      save: async () => {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
      },
    });
    doc.setValue("b");
    scheduler.runAll();
    await flushMicrotasks();
    expect(doc.getSnapshot().state).toBe("dirty");
    expect(scheduler.pending()).toBe(1);

    scheduler.runAll();
    await flushMicrotasks();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(calls).toBe(2);
  });

  test("mtime conflict: a newer on-disk copy with different content refuses the save", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
      },
      readExternal: async () => ({ content: "someone else", mtimeMs: 200 }),
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("conflict");
    expect(saved).toEqual([]);
  });

  test("no conflict when the external copy is older or identical", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
        return { mtimeMs: 300 };
      },
      readExternal: async () => ({ content: "mine", mtimeMs: 100 }),
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().mtimeMs).toBe(300);
  });

  test("a failed external read never blocks a save", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
      },
      readExternal: async () => {
        throw new Error("stat failed");
      },
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(saved).toEqual(["mine edited"]);
  });

  test("discardExternal re-baselines and force-saves the local text", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
        return { mtimeMs: 250 };
      },
      readExternal: async () => ({ content: "someone else", mtimeMs: 200 }),
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("conflict");

    await doc.discardExternal();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().value).toBe("mine edited");
    expect(saved).toEqual(["mine edited"]);
    expect(doc.getSnapshot().mtimeMs).toBe(250);
  });

  test("subscribers are notified on transitions and unsubscribe works", async () => {
    const states: AutosaveState[] = [];
    const doc = createAutosaveDoc({ initialValue: "a", save: async () => {} });
    const unsubscribe = doc.subscribe(() => states.push(doc.getSnapshot().state));
    doc.setValue("b");
    await doc.saveNow();
    unsubscribe();
    doc.setValue("c");
    expect(states).toEqual(["dirty", "saving", "saved"]);
  });

  test("dispose cancels a pending debounce", () => {
    const scheduler = manualScheduler();
    const doc = createAutosaveDoc({ initialValue: "a", schedule: scheduler.schedule, save: async () => {} });
    doc.setValue("b");
    doc.dispose();
    expect(scheduler.pending()).toBe(0);
  });
});

describe("autosaveStatusText", () => {
  test("maps states to reduced-motion-safe plain text", () => {
    expect(autosaveStatusText("clean")).toBe("");
    expect(autosaveStatusText("dirty")).toBe("Unsaved");
    expect(autosaveStatusText("saving")).toBe("Saving…");
    expect(autosaveStatusText("saved")).toBe("Saved");
    expect(autosaveStatusText("conflict")).toBe("Changed on disk");
  });
});

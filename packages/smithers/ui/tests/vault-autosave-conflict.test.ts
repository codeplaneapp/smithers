import { describe, expect, test } from "bun:test";
import { createAutosaveDoc } from "../src/vault/autosaveMachine";

/**
 * The conflict predicate `AutosaveDocOptions.readExternal` documents: differing
 * content AND an on-disk mtime that is not strictly older than our baseline.
 * The matrix below is the whole predicate, crossed with the cases where a
 * baseline is unavailable.
 */
type Case = {
  readonly name: string;
  readonly externalMtimeMs: number | undefined;
  readonly baselineMtimeMs: number | undefined;
  readonly externalContent: string;
  readonly conflict: boolean;
};

const CASES: readonly Case[] = [
  {
    name: "newer mtime, differing content",
    externalMtimeMs: 200,
    baselineMtimeMs: 100,
    externalContent: "someone else",
    conflict: true,
  },
  {
    name: "equal mtime, differing content (coarse-granularity filesystems)",
    externalMtimeMs: 100,
    baselineMtimeMs: 100,
    externalContent: "someone else",
    conflict: true,
  },
  {
    name: "older mtime, differing content",
    externalMtimeMs: 50,
    baselineMtimeMs: 100,
    externalContent: "someone else",
    conflict: false,
  },
  {
    name: "newer mtime, identical content",
    externalMtimeMs: 200,
    baselineMtimeMs: 100,
    externalContent: "mine",
    conflict: false,
  },
  {
    name: "equal mtime, identical content",
    externalMtimeMs: 100,
    baselineMtimeMs: 100,
    externalContent: "mine",
    conflict: false,
  },
  {
    name: "missing external mtime, differing content",
    externalMtimeMs: undefined,
    baselineMtimeMs: 100,
    externalContent: "someone else",
    conflict: true,
  },
  {
    name: "missing baseline mtime, differing content",
    externalMtimeMs: 200,
    baselineMtimeMs: undefined,
    externalContent: "someone else",
    conflict: true,
  },
  {
    name: "missing external mtime, identical content",
    externalMtimeMs: undefined,
    baselineMtimeMs: 100,
    externalContent: "mine",
    conflict: false,
  },
  {
    name: "NaN external mtime, differing content",
    externalMtimeMs: Number.NaN,
    baselineMtimeMs: 100,
    externalContent: "someone else",
    conflict: true,
  },
  {
    name: "NaN baseline mtime, differing content",
    externalMtimeMs: 200,
    baselineMtimeMs: Number.NaN,
    externalContent: "someone else",
    conflict: true,
  },
];

describe("autosave conflict detection reads both halves of its predicate", () => {
  for (const scenario of CASES) {
    test(scenario.name, async () => {
      const saved: string[] = [];
      const doc = createAutosaveDoc({
        initialValue: "mine",
        ...(scenario.baselineMtimeMs === undefined ? {} : { initialMtimeMs: scenario.baselineMtimeMs }),
        save: async (value) => {
          saved.push(value);
        },
        readExternal: async () => ({
          content: scenario.externalContent,
          ...(scenario.externalMtimeMs === undefined ? {} : { mtimeMs: scenario.externalMtimeMs }),
        }),
      });
      doc.setValue("mine edited");
      await doc.saveNow();

      expect(doc.getSnapshot().state).toBe(scenario.conflict ? "conflict" : "saved");
      expect(saved).toEqual(scenario.conflict ? [] : ["mine edited"]);
      // A genuine concurrent edit is not a failure; it is the machine working.
      expect(doc.getSnapshot().failure).toBeUndefined();
    });
  }
});

describe("autosave names its failures", () => {
  test("a throwing readExternal fails closed with a read-failed code and the cause", async () => {
    const cause = new Error("stat failed");
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
      },
      readExternal: async () => {
        throw cause;
      },
    });
    doc.setValue("mine edited");
    await doc.saveNow();

    expect(doc.getSnapshot().state).toBe("conflict");
    expect(doc.getSnapshot().failure).toEqual({ code: "read-failed", cause });
    expect(saved).toEqual([]);
  });

  test("a rejecting save reports write-failed with the cause and stays dirty", async () => {
    const cause = new Error("disk full");
    const doc = createAutosaveDoc({
      initialValue: "mine",
      schedule: () => () => {},
      save: async () => {
        throw cause;
      },
    });
    doc.setValue("mine edited");
    await doc.saveNow();

    expect(doc.getSnapshot().state).toBe("dirty");
    expect(doc.getSnapshot().failure).toEqual({ code: "write-failed", cause });
  });

  test("the three outcomes are distinguishable from one another", async () => {
    const outcome = (snapshot: { state: string; failure?: { code: string } | undefined }) =>
      `${snapshot.state}:${snapshot.failure?.code ?? "none"}`;

    const conflicted = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async () => {},
      readExternal: async () => ({ content: "someone else", mtimeMs: 200 }),
    });
    conflicted.setValue("edited");
    await conflicted.saveNow();

    const unreadable = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async () => {},
      readExternal: async () => {
        throw new Error("stat failed");
      },
    });
    unreadable.setValue("edited");
    await unreadable.saveNow();

    const unwritable = createAutosaveDoc({
      initialValue: "mine",
      schedule: () => () => {},
      save: async () => {
        throw new Error("disk full");
      },
    });
    unwritable.setValue("edited");
    await unwritable.saveNow();

    expect([conflicted, unreadable, unwritable].map((doc) => outcome(doc.getSnapshot()))).toEqual([
      "conflict:none",
      "conflict:read-failed",
      "dirty:write-failed",
    ]);
  });

  test("a later success clears the recorded failure", async () => {
    let fails = true;
    const doc = createAutosaveDoc({
      initialValue: "mine",
      schedule: () => () => {},
      save: async () => {
        if (fails) throw new Error("disk full");
      },
    });
    doc.setValue("edited");
    await doc.saveNow();
    expect(doc.getSnapshot().failure?.code).toBe("write-failed");

    fails = false;
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().failure).toBeUndefined();
  });
});

describe("saveNow grants no force-overwrite capability", () => {
  test("a JS caller passing force cannot bypass a pending conflict", async () => {
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
    await (doc.saveNow as (force?: boolean) => Promise<void>)(true);

    expect(doc.getSnapshot().state).toBe("conflict");
    expect(saved).toEqual([]);

    // The sanctioned overwrite still works, and it re-baselines first.
    await doc.discardExternal();
    expect(saved).toEqual(["mine edited"]);
  });
});

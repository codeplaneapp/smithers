import { describe, expect, test } from "bun:test";
import { createAutosaveDoc } from "../src/vault/autosaveMachine";

describe("autosave conditional commits", () => {
  for (const overwrite of [false, true]) {
    test(`fences a writer arriving after the read (discardExternal=${overwrite})`, async () => {
      let disk = { content: "original", mtimeMs: 1 };
      const cause = new Error("revision changed");
      let expectedRevision: typeof disk | undefined;
      const doc = createAutosaveDoc({
        initialValue: "original",
        initialMtimeMs: 1,
        schedule: () => () => {},
        readExternal: async () => ({ ...disk }),
        save: async (value, expected?: { content: string; mtimeMs?: number }) => {
          expectedRevision = expected as typeof disk | undefined;
          // Atomic backend transaction: another writer committed after our read.
          disk = { content: "other writer edit", mtimeMs: 2 };
          if (expected && (expected.content !== disk.content || expected.mtimeMs !== disk.mtimeMs)) {
            return { status: "conflict" as const, cause };
          }
          disk = { content: value, mtimeMs: 3 };
          return { mtimeMs: 3 };
        },
      });
      doc.setValue("local draft");
      await (overwrite ? doc.discardExternal() : doc.saveNow());
      expect(disk).toEqual({ content: "other writer edit", mtimeMs: 2 });
      expect(expectedRevision).toEqual({ content: "original", mtimeMs: 1 });
      expect(doc.getSnapshot()).toMatchObject({
        value: "local draft", state: "conflict", mtimeMs: 1,
        failure: { code: "conflict", cause },
      });
      doc.dispose();
    });
  }

  test("discardExternal fails closed when its revision cannot be read", async () => {
    const cause = new Error("offline");
    let writes = 0;
    const doc = createAutosaveDoc({
      initialValue: "original", schedule: () => () => {},
      readExternal: async () => { throw cause; },
      save: async () => { writes++; },
    });
    doc.setValue("draft");
    await doc.discardExternal();
    expect(writes).toBe(0);
    expect(doc.getSnapshot().failure).toEqual({ code: "read-failed", cause });
    doc.dispose();
  });
});

import { describe, expect, test } from "bun:test";

const FIRST_NS = { kind: "user", id: "contract-first" };
const SECOND_NS = { kind: "workflow", id: "contract-second" };

/**
 * Shared public-contract concurrency checks for every MemoryStore backend.
 *
 * @param {string} label
 * @param {() => Promise<{
 *   store: import("../src/store/MemoryStore.ts").MemoryStore;
 *   secondStore: import("../src/store/MemoryStore.ts").MemoryStore;
 *   cleanup: () => void | Promise<void>;
 * }>} createHarness
 */
export function memoryStoreConcurrencyContract(label, createHarness) {
  describe(`${label}: shared MemoryStore concurrency contract`, () => {
    test("same fact identity remains one valid last-writer row", async () => {
      const harness = await createHarness();
      try {
        await Promise.all([
          harness.store.setFact(FIRST_NS, "shared", { writer: "first" }),
          harness.secondStore.setFact(FIRST_NS, "shared", { writer: "second" }),
        ]);
        const facts = await harness.store.listFacts(FIRST_NS);
        expect(facts).toHaveLength(1);
        expect(["first", "second"]).toContain(JSON.parse(facts[0].valueJson).writer);
      } finally {
        await harness.cleanup();
      }
    });

    test("message ids are global across namespaces under contention", async () => {
      const harness = await createHarness();
      try {
        const firstThread = await harness.store.createThread(FIRST_NS);
        const secondThread = await harness.store.createThread(SECOND_NS);
        await Promise.all([
          harness.store.saveMessage({
            id: "global-message",
            threadId: firstThread.threadId,
            role: "assistant",
            contentJson: JSON.stringify({ writer: "first" }),
            createdAtMs: 1,
          }),
          harness.secondStore.saveMessage({
            id: "global-message",
            threadId: secondThread.threadId,
            role: "assistant",
            contentJson: JSON.stringify({ writer: "second" }),
            createdAtMs: 1,
          }),
        ]);
        const messages = [
          ...(await harness.store.listMessages(firstThread.threadId)),
          ...(await harness.store.listMessages(secondThread.threadId)),
        ];
        expect(messages).toHaveLength(1);
        expect(messages[0].id).toBe("global-message");
        expect(["first", "second"]).toContain(JSON.parse(messages[0].contentJson).writer);
      } finally {
        await harness.cleanup();
      }
    });

    test("same-id notes choose one immutable global winner and one supersession edge", async () => {
      const harness = await createHarness();
      try {
        const firstVictim = await harness.store.saveNote({ namespace: FIRST_NS, body: "first victim" });
        const secondVictim = await harness.store.saveNote({ namespace: SECOND_NS, body: "second victim" });
        const [firstResult, secondResult] = await Promise.all([
          harness.store.saveNote({
            namespace: FIRST_NS,
            body: "first writer",
            id: "global-note",
            supersedes: [firstVictim.id],
          }),
          harness.secondStore.saveNote({
            namespace: SECOND_NS,
            body: "second writer",
            id: "global-note",
            supersedes: [secondVictim.id],
          }),
        ]);

        expect(firstResult).toEqual(secondResult);
        expect(await harness.store.getNote("global-note")).toEqual(firstResult);
        const firstLive = await harness.store.listNotes(FIRST_NS);
        const secondLive = await harness.store.listNotes(SECOND_NS);
        const globalWinners = [...firstLive, ...secondLive].filter((note) => note.id === "global-note");
        expect(globalWinners).toHaveLength(1);
        if (firstResult.body === "first writer") {
          expect(firstLive.map((note) => note.body)).toEqual(["first writer"]);
          expect(secondLive.map((note) => note.body)).toEqual(["second victim"]);
        } else {
          expect(firstLive.map((note) => note.body)).toEqual(["first victim"]);
          expect(secondLive.map((note) => note.body)).toEqual(["second writer"]);
        }
      } finally {
        await harness.cleanup();
      }
    });
  });
}

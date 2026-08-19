import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  compileGraphSnapshot,
  computeImplementation,
  implementationLayers,
  staticImplementation,
} from "../src/index.ts";
import { fixtures, snapshotOf } from "./fixtures/index.ts";

const compiled = compileGraphSnapshot(snapshotOf(fixtures.find((entry) => entry.id === "linear-sequence")!));

describe("action bodies", () => {
  test("a compute step's body runs the task's own computeFn", async () => {
    const run = computeImplementation(compiled);
    await expect(Effect.runPromise(run({ nodeId: "shape" }))).resolves.toEqual({ shaped: true });
  });

  test("a dispatch for a node this compilation never saw is a defect", async () => {
    const run = computeImplementation(compiled);
    await expect(Effect.runPromise(run({ nodeId: "ghost" }))).rejects.toThrow();
  });

  test("a static step's body is its sealed constant", async () => {
    await expect(Effect.runPromise(staticImplementation({ value: { topic: "x" } }))).resolves.toEqual({
      topic: "x",
    });
  });

  test("every non-agent action tier gets an implementation layer", () => {
    expect(implementationLayers(compiled)).toBeDefined();
  });
});

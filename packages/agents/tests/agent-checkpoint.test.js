import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_CHECKPOINT_MAX_BYTES,
  agentProducesCheckpoint,
  agentSupportsCheckpoint,
  cloneAgentCheckpoint,
  hashAgentCheckpointCapabilities,
} from "../src/index.js";
import { cloneAgentCheckpoint as cloneFromStablePath } from "../src/agent-checkpoint.js";

describe("agent checkpoints", () => {
  test("clones a valid envelope without retaining mutable references", () => {
    const payload = { cursor: 3, nested: [null, true, "ok", 1.5] };
    const source = { codec: "example/session", version: 1, payload };
    const cloned = cloneAgentCheckpoint(source);

    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.payload).not.toBe(payload);
    expect(DEFAULT_AGENT_CHECKPOINT_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(cloneFromStablePath(source)).toEqual(source);
  });

  test("allows JSON scalar and null payloads", () => {
    for (const payload of [null, "cursor", true, false, 0, 1.25]) {
      expect(cloneAgentCheckpoint({ codec: "scalar", version: 1, payload }).payload).toBe(payload);
    }
  });

  test("rejects invalid envelope metadata", () => {
    expect(() => cloneAgentCheckpoint(null)).toThrow("plain object");
    expect(() => cloneAgentCheckpoint({ codec: "", version: 1, payload: null })).toThrow("non-empty string");
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 0, payload: null })).toThrow("positive safe integer");
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1.5, payload: null })).toThrow("positive safe integer");
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload: null, extra: true })).toThrow("exactly");
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1 })).toThrow("exactly");
  });

  test("rejects every value JSON would omit or coerce", () => {
    const rejected = [undefined, () => {}, Symbol("x"), 1n, NaN, Infinity, -Infinity];
    for (const payload of rejected) {
      expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload })).toThrow();
    }
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload: { missing: undefined } })).toThrow();
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload: new Date() })).toThrow("non-plain");

    const symbolObject = { value: 1 };
    symbolObject[Symbol("hidden")] = 2;
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload: symbolObject })).toThrow("symbol-keyed");

    const accessorObject = {};
    Object.defineProperty(accessorObject, "value", { enumerable: true, get: () => 1 });
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload: accessorObject })).toThrow("accessor");

    const customArray = [1];
    customArray.extra = 2;
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload: customArray })).toThrow("array properties");
  });

  test("rejects cycles while allowing repeated non-cyclic references", () => {
    const cycle = {};
    cycle.self = cycle;
    expect(() => cloneAgentCheckpoint({ codec: "x", version: 1, payload: cycle })).toThrow("cycle");

    const shared = { value: 1 };
    expect(cloneAgentCheckpoint({ codec: "x", version: 1, payload: [shared, shared] }).payload).toEqual([
      { value: 1 },
      { value: 1 },
    ]);
  });

  test("enforces the encoded UTF-8 byte limit", () => {
    const checkpoint = { codec: "x", version: 1, payload: "é" };
    expect(() => cloneAgentCheckpoint(checkpoint, 10)).toThrow("exceeds 10 bytes");
    expect(() => cloneAgentCheckpoint(checkpoint, 0)).toThrow("positive safe integer");
  });

  test("rejects a configured limit above the 16 MiB durability ceiling", () => {
    expect(() =>
      cloneAgentCheckpoint(
        { codec: "example/session", version: 1, payload: null },
        DEFAULT_AGENT_CHECKPOINT_MAX_BYTES + 1,
      ),
    ).toThrow("system ceiling");
  });

  test("matches checkpoint codec, version, and explicit mode", () => {
    const checkpoint = { codec: "example/session", version: 2, payload: null };
    const resumeOnly = {
      checkpointCapabilities: [{ codec: "example/session", versions: [2], modes: ["resume"] }],
    };
    expect(agentSupportsCheckpoint(resumeOnly, checkpoint, "resume")).toBe(true);
    expect(agentSupportsCheckpoint(resumeOnly, checkpoint, "fork")).toBe(false);
    expect(agentSupportsCheckpoint(resumeOnly, { ...checkpoint, version: 1 }, "resume")).toBe(false);
    expect(
      agentSupportsCheckpoint(
        { checkpointCapabilities: [{ codec: "example/session", versions: [2], modes: [] }] },
        checkpoint,
        "resume",
      ),
    ).toBe(false);
  });

  test("declares produced formats independently from consumed modes", () => {
    const checkpoint = { codec: "example/session", version: 2, payload: null };
    const producerOnly = {
      checkpointFormats: [{ codec: "example/session", versions: [2] }],
      checkpointCapabilities: [],
    };

    expect(agentProducesCheckpoint(producerOnly, checkpoint)).toBe(true);
    expect(agentSupportsCheckpoint(producerOnly, checkpoint, "resume")).toBe(false);
    expect(agentProducesCheckpoint(producerOnly, { ...checkpoint, version: 1 })).toBe(false);
    expect(
      agentProducesCheckpoint(
        { checkpointCapabilities: [{ codec: "example/session", versions: [2], modes: ["resume"] }] },
        checkpoint,
      ),
    ).toBe(false);
  });

  test("hashes checkpoint declarations canonically", () => {
    const first = {
      checkpointFormats: [
        { codec: "b", versions: [2, 1, 2] },
        { codec: "a", versions: [1] },
      ],
      checkpointCapabilities: [
        { codec: "b", versions: [2, 1], modes: ["fork", "resume", "fork"] },
        { codec: "a", versions: [1], modes: ["resume"] },
      ],
    };
    const reordered = {
      checkpointFormats: [
        { codec: "a", versions: [1, 1] },
        { codec: "b", versions: [1, 2] },
      ],
      checkpointCapabilities: [
        { codec: "a", versions: [1, 1], modes: ["resume"] },
        { codec: "b", versions: [1], modes: ["resume", "fork"] },
        { codec: "b", versions: [2], modes: ["resume", "fork"] },
      ],
    };

    expect(hashAgentCheckpointCapabilities(first)).toBe(hashAgentCheckpointCapabilities(reordered));
    expect(hashAgentCheckpointCapabilities(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashAgentCheckpointCapabilities(first)).not.toBe(
      hashAgentCheckpointCapabilities({ ...reordered, checkpointFormats: [{ codec: "a", versions: [1] }] }),
    );
    expect(hashAgentCheckpointCapabilities(first)).not.toBe(
      hashAgentCheckpointCapabilities({ ...reordered, checkpointCapabilities: [] }),
    );
    expect(hashAgentCheckpointCapabilities(null)).toBe(hashAgentCheckpointCapabilities({}));
  });
});

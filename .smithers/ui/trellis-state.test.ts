import { describe, expect, test } from "bun:test";
import { findTrellisNodeByPhase, trellisMetaOf, trellisNodeOutputRevision, trellisRunTruthOf } from "./trellis-state";

describe("Trellis UI metadata", () => {
  test("finds semantic final nodes without parsing their physical id", () => {
    const nodes = [
      { id: "trellis:final:not-the-final", meta: JSON.stringify({ trellis: { phase: "worker" } }) },
      { id: "opaque-semantic-id", meta: JSON.stringify({ trellis: { phase: "final", logicalId: "root" } }) },
    ];
    expect(findTrellisNodeByPhase(nodes, "final")?.id).toBe("opaque-semantic-id");
  });

  test("ignores malformed and non-Trellis metadata", () => {
    expect(trellisMetaOf({ id: "bad", meta: "{" })).toBeUndefined();
    expect(trellisMetaOf({ id: "other", meta: JSON.stringify({ phase: "final" }) })).toBeUndefined();
  });

  test("invalidates node output only for its live status or terminal event", () => {
    const node = { id: "opaque-node", iteration: 2, status: "running" };
    const events = [
      { seq: 3, event: "NodeFinished", payload: { nodeId: "other", iteration: 2 } },
      { seq: 4, event: "NodeFinished", payload: { nodeId: "opaque-node", iteration: 1 } },
      { seq: 9, event: "node.finished", payload: { nodeId: "opaque-node", iteration: 2 } },
    ];
    expect(trellisNodeOutputRevision(node, events)).toBe("running:9");
    expect(trellisNodeOutputRevision({ ...node, status: "ok" }, events)).toBe("ok:9");
  });

  test("reads selected-run concurrency and fuel from persisted root metadata", () => {
    const nodes = [
      {
        id: "root-author-0",
        meta: JSON.stringify({
          trellis: {
            phase: "initial",
            logicalId: "root",
            rootMaxConcurrency: 3,
            rootAuthorTurnsTotal: 17,
            rootMaxAuthorGenerations: 5,
            rootMaxAuthorDepth: 4,
            invocationAuthorTurnsAllocated: 17,
            invocationAuthorTurnsRemaining: 16,
          },
        }),
      },
      {
        id: "child-author",
        meta: JSON.stringify({
          trellis: {
            phase: "initial",
            logicalId: "child",
            rootMaxConcurrency: 3,
            rootAuthorTurnsTotal: 17,
            invocationAuthorTurnsAllocated: 4,
            invocationAuthorTurnsRemaining: 1,
          },
        }),
      },
      {
        id: "root-author-1",
        meta: JSON.stringify({
          trellis: {
            phase: "continuation",
            logicalId: "root",
            rootMaxConcurrency: 3,
            rootAuthorTurnsTotal: 17,
            invocationAuthorTurnsAllocated: 17,
            invocationAuthorTurnsRemaining: 7,
          },
        }),
      },
      {
        id: "root-final",
        meta: JSON.stringify({
          trellis: {
            phase: "final",
            logicalId: "root",
            rootMaxConcurrency: 3,
            rootAuthorTurnsTotal: 17,
            rootMaxAuthorGenerations: 5,
            rootMaxAuthorDepth: 4,
            invocationAuthorTurnsAllocated: 17,
          },
        }),
      },
    ];
    expect(trellisRunTruthOf(nodes)).toEqual({
      rootMaxConcurrency: 3,
      rootAuthorTurnsTotal: 17,
      rootMaxAuthorGenerations: 5,
      rootMaxAuthorDepth: 4,
      rootAuthorTurnsAllocated: 17,
      rootAuthorTurnsRemaining: 7,
    });
  });

  test("does not invent run truth when persisted fields are absent or invalid", () => {
    expect(
      trellisRunTruthOf([
        { id: "legacy", meta: JSON.stringify({ trellis: { phase: "initial", logicalId: "root" } }) },
        {
          id: "malformed",
          meta: JSON.stringify({
            trellis: {
              phase: "final",
              logicalId: "root",
              rootMaxConcurrency: 0,
              rootAuthorTurnsTotal: "32",
            },
          }),
        },
      ]),
    ).toBeUndefined();
  });
});

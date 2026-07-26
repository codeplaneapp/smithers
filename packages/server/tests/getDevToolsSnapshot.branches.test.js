import { describe, expect, test } from "bun:test";
import {
  parseXmlToDevToolsRoot,
  snapshotFromFrameRow,
  getDevToolsSnapshotRoute,
  DEVTOOLS_EMPTY_ROOT_ID,
} from "../src/gatewayRoutes/getDevToolsSnapshot.js";

/**
 * Branch coverage for the pure XML→DevTools transform helpers: prop-value
 * coercion, task-info extraction fallbacks, task-index parsing fallbacks, the
 * non-element short-circuit, the malformed-xmlJson catch, and the node-id
 * collision rehash loop.
 */

function element(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

describe("getDevToolsSnapshot transform branches", () => {
  test("parsePropValue coerces string prop values by shape", () => {
    const root = parseXmlToDevToolsRoot(
      element("smithers:task", {
        id: "p1",
        pTrue: "true",
        pFalse: "false",
        pNull: "null",
        pInt: "42",
        pFloat: "-3.5",
        pObj: '{"a":1}',
        pArr: "[1,2,3]",
        pBadJson: "{not valid json}",
        pPlain: "hello",
      }),
    );
    expect(root.props.pTrue).toBe(true);
    expect(root.props.pFalse).toBe(false);
    expect(root.props.pNull).toBe(null);
    expect(root.props.pInt).toBe(42);
    expect(root.props.pFloat).toBe(-3.5);
    expect(root.props.pObj).toEqual({ a: 1 });
    expect(root.props.pArr).toEqual([1, 2, 3]);
    // Looks like an object but is not valid JSON → left as the raw string.
    expect(root.props.pBadJson).toBe("{not valid json}");
    expect(root.props.pPlain).toBe("hello");
  });

  test("digit-only prop that overflows to Infinity is left as the raw string", () => {
    // Matches the numeric regex but Number(...) is not finite, so the
    // isFinite guard falls through and the value stays a plain string.
    const huge = "9".repeat(400);
    const root = parseXmlToDevToolsRoot(element("smithers:task", { id: "p2", pHuge: huge }));
    expect(Number(huge)).toBe(Infinity);
    expect(root.props.pHuge).toBe(huge);
  });

  test("extractTaskInfo falls back to props.nodeId when props.id is absent", () => {
    // props.id is not a string; props.nodeId is → rawNodeId comes from nodeId.
    const root = parseXmlToDevToolsRoot(element("smithers:task", { nodeId: "task-b::3" }));
    expect(root.task).toBeDefined();
    expect(root.task.nodeId).toBe("task-b");
    // The `::3` suffix is parsed into the iteration.
    expect(root.task.iteration).toBe(3);
  });

  test("extractTaskInfo returns undefined task when neither id nor nodeId is a string", () => {
    const root = parseXmlToDevToolsRoot(element("smithers:task", { label: "no identity here" }));
    expect(root.type).toBe("task");
    expect(root.task).toBeUndefined();
  });

  test("parseXmlToDevToolsRoot returns the empty root for a non-element input", () => {
    const fromNull = parseXmlToDevToolsRoot(null);
    expect(fromNull.id).toBe(DEVTOOLS_EMPTY_ROOT_ID);
    expect(fromNull.name).toBe("(empty)");
    const fromText = parseXmlToDevToolsRoot({ kind: "text", value: "x" });
    expect(fromText.id).toBe(DEVTOOLS_EMPTY_ROOT_ID);
  });

  test("assignId rehashes on a real node-id hash collision to keep ids unique", () => {
    // "c3rnw" and "ckpba" produce the SAME FNV-1a-31bit id for their sibling
    // paths under this root, so the second assignId hits the collision rehash
    // loop. Uniqueness must still hold.
    const root = parseXmlToDevToolsRoot(
      element("smithers:workflow", { id: "r" }, [
        element("smithers:task", { id: "c3rnw" }),
        element("smithers:task", { id: "ckpba" }),
      ]),
    );
    expect(root.children).toHaveLength(2);
    const [a, b] = root.children;
    expect(a.id).not.toBe(b.id);
    // Both ids stay within the 31-bit positive range.
    expect(a.id).toBeGreaterThanOrEqual(0);
    expect(b.id).toBeGreaterThanOrEqual(0);
  });

  describe("snapshotFromFrameRow + parseTaskIndex fallbacks", () => {
    test("null taskIndexJson yields no task metadata", () => {
      const snap = snapshotFromFrameRow({
        runId: "run-a",
        frameNo: 0,
        xmlJson: JSON.stringify(element("smithers:task", { id: "t1" })),
        taskIndexJson: null,
      });
      expect(snap.root.task.nodeId).toBe("t1");
      // With no index, kind falls back to static.
      expect(snap.root.task.kind).toBe("static");
    });

    test("malformed taskIndexJson is tolerated (caught → empty index)", () => {
      const snap = snapshotFromFrameRow({
        runId: "run-b",
        frameNo: 1,
        xmlJson: JSON.stringify(element("smithers:task", { id: "t2" })),
        taskIndexJson: "{ this is not json",
      });
      expect(snap.root.task.nodeId).toBe("t2");
    });

    test("non-array taskIndexJson is treated as an empty index", () => {
      const snap = snapshotFromFrameRow({
        runId: "run-c",
        frameNo: 2,
        xmlJson: JSON.stringify(element("smithers:task", { id: "t3" })),
        taskIndexJson: JSON.stringify({ not: "an array" }),
      });
      expect(snap.root.task.nodeId).toBe("t3");
    });

    test("a valid task index supplies iteration and kind metadata", () => {
      const snap = snapshotFromFrameRow({
        runId: "run-d",
        frameNo: 3,
        xmlJson: JSON.stringify(element("smithers:task", { id: "t4" })),
        taskIndexJson: JSON.stringify([{ nodeId: "t4", iteration: 7, kind: "agent" }]),
      });
      expect(snap.root.task.kind).toBe("agent");
      expect(snap.root.task.iteration).toBe(7);
    });

    test("malformed xmlJson is caught and yields the empty root", () => {
      const snap = snapshotFromFrameRow({
        runId: "run-e",
        frameNo: 4,
        xmlJson: "not-json{",
        taskIndexJson: null,
      });
      expect(snap.root.id).toBe(DEVTOOLS_EMPTY_ROOT_ID);
      expect(snap.frameNo).toBe(4);
    });
  });

  describe("getDevToolsSnapshotRoute runState degradation", () => {
    test("a failure computing runState degrades gracefully to no runState", async () => {
      // A waiting-approval run drives computeRunStateFromRow into
      // listPendingApprovals; when that throws, the route's .catch(() =>
      // undefined) swallows it and the snapshot is returned without runState.
      const adapter = {
        getRun: async () => ({
          runId: "wa",
          status: "waiting-approval",
          createdAtMs: 1,
          startedAtMs: 1,
          heartbeatAtMs: 1,
        }),
        listPendingApprovals: async () => {
          throw new Error("approvals query failed");
        },
        getLastFrame: async () => null,
      };
      const snap = await getDevToolsSnapshotRoute({ adapter, runId: "wa", frameNo: 0 });
      expect(snap.runId).toBe("wa");
      expect(snap.frameNo).toBe(0);
      expect(snap.root.id).toBe(DEVTOOLS_EMPTY_ROOT_ID);
      // runState computation failed, so the field is omitted entirely.
      expect(snap.runState).toBeUndefined();
    });

    test("a healthy waiting-approval run keeps its computed runState", async () => {
      const adapter = {
        getRun: async () => ({
          runId: "wa2",
          status: "waiting-approval",
          createdAtMs: 1,
          startedAtMs: 1,
          heartbeatAtMs: 1,
        }),
        listPendingApprovals: async () => [{ nodeId: "gate", requestedAtMs: 5 }],
        getLastFrame: async () => null,
      };
      const snap = await getDevToolsSnapshotRoute({ adapter, runId: "wa2", frameNo: 0 });
      expect(snap.runState).toBeDefined();
    });
  });
});

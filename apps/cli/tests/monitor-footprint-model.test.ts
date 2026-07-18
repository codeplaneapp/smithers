import { expect, test } from "bun:test";
import { footprintNodeKey, footprintNote, footprintOf, formatFootprintSummary, rankedDirectories, rankedFiles } from "../src/monitor-ui/monitorFootprintModel.ts";
import { treeNodeKey } from "../src/monitor-ui/monitorModel.ts";
import { matchesAutoSelectNode } from "../src/monitor-ui/monitorExecution.tsx";

const payload = {
  filesChanged: 1,
  directories: [{ path: "src", files: 1, added: 2, removed: 3 }],
  files: [{ path: "src/a.ts", added: 2, removed: 3, nodes_touched: 1, owner: { node_id: "task", iteration: 2 } }],
  added: 2,
  removed: 3,
  hottest_directory: { path: "src", files: 1, added: 2, removed: 3 },
  skipped_nodes: 1,
};
test("reads envelopes, bare payloads, and snake_case fields", () => {
  const footprint = footprintOf({ ok: true, data: payload });
  expect(formatFootprintSummary(footprint)).toBe("1 file across 1 dir, hottest: src +2/−3");
  expect(footprint?.files[0].owner).toEqual({ nodeId: "task", iteration: 2 });
  expect(footprintOf(payload)?.totalFiles).toBe(1);
  expect(footprintOf({ nope: true })).toBeNull();
});
test("ranking is stable and notes are honest", () => {
  const footprint = footprintOf({
    ...payload,
    filesChanged: 3,
    directories: [
      ...payload.directories,
      { path: "lib", files: 1, added: 9, removed: 0 },
    ],
    files: [
      { path: "cold.ts", added: 1, removed: 0, nodesTouched: 1 },
      ...payload.files,
      { path: "hot.ts", added: 9, removed: 0, nodesTouched: 1 },
    ],
    truncated: true,
  });
  expect(rankedFiles(footprint).map((file) => file.path)).toEqual(["hot.ts", "src/a.ts", "cold.ts"]);
  expect(rankedDirectories(footprint).map((directory) => directory.path)).toEqual(["lib", "src"]);
  expect(footprintNote(footprint)).toBe("showing top changed files · 1 node was unavailable");
  expect(formatFootprintSummary(null)).toBe("footprint unavailable");
  expect(formatFootprintSummary(footprintOf({ filesChanged: 0, directories: [], files: [] }))).toBe("no file changes yet");
});
test("loop keys select a real iteration even with a structural tree key", () => {
  expect(footprintNodeKey("task", 0)).toBe(treeNodeKey({ id: "task" }));
  const loopNode = { id: "task", iteration: 2, key: "devtools-fiber-93" };
  expect(footprintNodeKey("task", 2)).toBe("task::2");
  expect(matchesAutoSelectNode(loopNode, footprintNodeKey("task", 2))).toBe(true);
  expect(matchesAutoSelectNode(loopNode, "task::1")).toBe(false);
});

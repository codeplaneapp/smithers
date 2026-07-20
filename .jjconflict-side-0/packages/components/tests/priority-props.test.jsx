/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { MERGE_QUEUE_PRIORITY } from "@smithers-orchestrator/graph/constants";
import { MergeQueue, Parallel, Task, Workflow } from "smithers-orchestrator";
import { outputSchemas } from "./schema.js";

/** @param {{ tasks: Array<{ nodeId: string }> }} res */
function byId(res) {
    return new Map(res.tasks.map((task) => [task.nodeId, task]));
}

describe("priority props", () => {
    test("Task priority prop lands on the descriptor", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="prio-task">
        <Task id="plain" output={outputSchemas.outputC}>
          {{ value: 1 }}
        </Task>
        <Task id="hot" priority={7} output={outputSchemas.outputC}>
          {{ value: 2 }}
        </Task>
      </Workflow>);
        const tasks = byId(res);
        expect(tasks.get("plain")?.priority).toBeUndefined();
        expect(tasks.get("hot")?.priority).toBe(7);
    }, 30_000);
    test("MergeQueue stamps MERGE_QUEUE_PRIORITY on child task descriptors by default", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="prio-mq">
        <MergeQueue id="queue">
          <Task id="land-1" output={outputSchemas.outputC}>
            {{ value: 1 }}
          </Task>
          <Task id="land-2" priority={3} output={outputSchemas.outputC}>
            {{ value: 2 }}
          </Task>
        </MergeQueue>
        <Task id="ticket" output={outputSchemas.outputC}>
          {{ value: 3 }}
        </Task>
      </Workflow>);
        const tasks = byId(res);
        expect(tasks.get("land-1")?.priority).toBe(MERGE_QUEUE_PRIORITY);
        // Explicit child priority overrides the queue's inherited default.
        expect(tasks.get("land-2")?.priority).toBe(3);
        expect(tasks.get("ticket")?.priority).toBeUndefined();
    }, 30_000);
    test("explicit MergeQueue priority replaces the default for its subtree", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="prio-mq-explicit">
        <MergeQueue id="queue" priority={40}>
          <Task id="land" output={outputSchemas.outputC}>
            {{ value: 1 }}
          </Task>
        </MergeQueue>
      </Workflow>);
        expect(byId(res).get("land")?.priority).toBe(40);
    }, 30_000);
    test("Parallel priority is inherited by descendant tasks", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="prio-parallel">
        <Parallel id="grp" priority={5}>
          <Task id="inherits" output={outputSchemas.outputC}>
            {{ value: 1 }}
          </Task>
          <Task id="overrides" priority={9} output={outputSchemas.outputC}>
            {{ value: 2 }}
          </Task>
        </Parallel>
      </Workflow>);
        const tasks = byId(res);
        expect(tasks.get("inherits")?.priority).toBe(5);
        expect(tasks.get("overrides")?.priority).toBe(9);
    }, 30_000);
});

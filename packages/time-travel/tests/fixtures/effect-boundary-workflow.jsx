/** @jsxImportSource smithers-orchestrator */
import { createSmithers, defineTool } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, outputs } = createSmithers(
  {
    result: z.object({ value: z.number() }),
  },
  { dbPath: ":memory:" },
);

const undoableTool = defineTool({
  name: "undoable-tool",
  schema: z.object({ value: z.number() }),
  sideEffect: true,
  idempotent: false,
  execute: async ({ value }, _context) => ({ value }),
  revert: async (input, context) => {
    globalThis.__smithersEffectBoundaryReverts?.push({
      kind: "tool",
      input,
      context,
    });
  },
});

const computeUndoableTool = defineTool({
  name: "compute-undoable-tool",
  schema: z.object({ value: z.number() }),
  sideEffect: true,
  idempotent: false,
  execute: async ({ value }, _context) => ({ value }),
  revert: async (input, context) => {
    globalThis.__smithersEffectBoundaryReverts?.push({
      kind: "compute-tool",
      input,
      context,
    });
  },
});

export const effectTools = { computeUndoableTool };

const agent = {
  tools: { undoableTool },
  async generate() {
    return { output: { value: 1 } };
  },
};

export default smithers(() => (
  <Workflow name="effect-boundary-fixture">
    <Task id="tool-node" output={outputs.result} agent={agent}>
      Call the tool.
    </Task>
    <Task
      id="task-node"
      output={outputs.result}
      sideEffect={{
        idempotent: false,
        revert: async (context) => {
          globalThis.__smithersEffectBoundaryReverts?.push({
            kind: "task",
            context,
          });
        },
      }}
    >
      {async () => ({ value: 2 })}
    </Task>
    <Task id="compute-tool-node" output={outputs.result}>
      {async () => await computeUndoableTool.execute({ value: 3 })}
    </Task>
  </Workflow>
));

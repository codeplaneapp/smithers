import { createSmithers } from "../index.js";
import { z } from "zod";
import type { AgentLike } from "@smithers-orchestrator/agents";

const agent = {
  generate: async () => ({ ok: true }),
} satisfies AgentLike;

const { Task, outputs } = createSmithers({
  next: z.object({
    ok: z.boolean(),
  }),
});

const _TaskForkJsx = (
  <Task id="next" output={outputs.next} agent={agent} fork="source">
    Continue from the source task.
  </Task>
);

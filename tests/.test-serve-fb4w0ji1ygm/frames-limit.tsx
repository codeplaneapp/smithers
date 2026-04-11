/** @jsxImportSource smithers */
import { createSmithers } from "smithers";
import { z } from "zod";

const fakeAgent = {
  id: "fake",
  tools: {},
  generate: async () => {
    await new Promise(r => setTimeout(r, 60000));
    return { output: { value: 1 } };
  },
};

const { smithers, Workflow, Task, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: "/Users/williamcory/smithers/tests/.test-serve-fb4w0ji1ygm/frames-limit.db" },
);

export default smithers((ctx) => (
  <Workflow name="frames-limit">
    <Task id="task1" output={outputs.outputA} agent={fakeAgent}>
      run task
    </Task>
  </Workflow>
));

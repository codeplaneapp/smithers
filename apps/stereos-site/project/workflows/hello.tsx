/** @jsxImportSource smthrs */
// Smallest real run: one literal Task, no agent and no model call.
import { openSmithersBackend, Sequence, Task } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = await openSmithersBackend({
  input: z.object({ name: z.string() }),
  greeting: z.object({ message: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="hello">
    <Sequence>
      <Task id="greet" output={outputs.greeting}>
        {{ message: `Hello, ${ctx.input.name}` }}
      </Task>
    </Sequence>
  </Workflow>
));

/** @jsxImportSource smithers-orchestrator */
	import { createSmithers } from "smithers-orchestrator";
	import { z } from "zod";
	
const fakeAgent = {
  id: "fake",
  tools: {},
  generate: async (args) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 60000);
      const abort = () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (args.abortSignal?.aborted) {
        abort();
        return;
      }
      args.abortSignal?.addEventListener("abort", abort, { once: true });
    });
    return { output: { value: 1 } };
  },
};
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "/Users/williamcory/smithers/packages/server/tests/.test-workflows-c3uosdin4tk/events.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="events">
	    <Task id="task1" output={outputs.outputA} agent={fakeAgent}>
	      run task
	    </Task>
	  </Workflow>
	));
	
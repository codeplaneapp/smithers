/** @jsxImportSource smithers */
	import { createSmithers } from "smithers";
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
	  { dbPath: "/Users/williamcory/smithers/tests/.test-workflows-ti4bv82h67o/frames2.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="frames2">
	    <Task id="task1" output={outputs.outputA} agent={fakeAgent}>
	      run task
	    </Task>
	  </Workflow>
	));
	
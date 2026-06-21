/** @jsxImportSource smithers-orchestrator */
	import { createSmithers } from "smithers-orchestrator";
	import { z } from "zod";
	
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "/Users/williamcory/smithers/packages/server/tests/.test-workflows-i4y4d5cg3k/duplicate-run.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="duplicate-run">
	    <Task id="task1" output={outputs.outputA}>
	      {{ value: 42 }}
	    </Task>
	  </Workflow>
	));
	
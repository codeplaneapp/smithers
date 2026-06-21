/** @jsxImportSource smithers-orchestrator */
	import { createSmithers } from "smithers-orchestrator";
	import { z } from "zod";
	
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "/Users/williamcory/smithers/packages/server/tests/.test-workflows-sb0y1rdzl89/test2.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="test2">
	    <Task id="task1" output={outputs.outputA}>
	      {{ value: 42 }}
	    </Task>
	  </Workflow>
	));
	
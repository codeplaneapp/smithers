/** @jsxImportSource smithers-orchestrator */
	import { createSmithers } from "smithers-orchestrator";
	import { z } from "zod";
	
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "/Users/williamcory/smithers/packages/server/tests/.test-workflows-r6zc53ye81/reload.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="reload">
	    <Task id="task1" output={outputs.outputA}>
	      {{ value: 7 }}
	    </Task>
	  </Workflow>
	));
	
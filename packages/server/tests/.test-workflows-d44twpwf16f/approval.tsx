/** @jsxImportSource smithers-orchestrator */
	import { createSmithers } from "smithers-orchestrator";
	import { z } from "zod";
	
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "/Users/williamcory/smithers/packages/server/tests/.test-workflows-d44twpwf16f/approval.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="approval">
	    <Task id="task1" output={outputs.outputA} needsApproval>
	      {{ value: 42 }}
	    </Task>
	  </Workflow>
	));
	
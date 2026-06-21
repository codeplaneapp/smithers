/** @jsxImportSource smithers-orchestrator */
	import { createSmithers } from "smithers-orchestrator";
	import { z } from "zod";
	
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "/Users/williamcory/smithers/packages/server/tests/.test-workflows-xqta81o39o/deny.db" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="deny">
	    <Task id="task1" output={outputs.outputA} needsApproval>
	      {{ value: 42 }}
	    </Task>
	  </Workflow>
	));
	
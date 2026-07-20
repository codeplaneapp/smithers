# Scope bounded live transcripts by iteration and attempt

GitHub: https://github.com/smithersai/smithers/issues/1153

Parent: smithers/smithers-gh-852-polish-execution-tree-retr-051acv6--complete-structured-node-output-and-error--0jj8193.md

Context: NodeLiveOutput bounds its retained lines but queries all events for a node, allowing loop iterations and retry attempts to leak into one transcript. Acceptance criteria: Add iteration and attempt filters to the event API/storage query; pass the selected node's iteration and attempt from the inspector; retain a bounded transcript and incremental cursor; add tests proving events from other iterations and attempts are excluded.

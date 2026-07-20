# Render all node-output envelope states in the execution-tree inspector

GitHub: https://github.com/smithersai/smithers/issues/1150

Parent: smithers/smithers-gh-852-polish-execution-tree-retr-051acv6--complete-structured-node-output-and-error--0jj8193.md

Context: The gateway returns produced, pending, and failed node-output envelopes, but the execution-tree inspector needs consistent state-aware rendering. Acceptance criteria: Unwrap produced envelopes to render their row; render pending envelopes as unavailable/pending rather than as data; render failed envelopes as failed; preserve structured object output; add focused inspector tests for all three states.

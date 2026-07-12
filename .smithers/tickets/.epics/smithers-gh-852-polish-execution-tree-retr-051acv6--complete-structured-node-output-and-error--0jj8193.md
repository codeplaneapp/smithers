# Complete structured node output and error inspection

GitHub: https://github.com/smithersai/smithers/issues/951

Parent: smithers/gh-852-polish-execution-tree-retries-and-node-inspection.md

Context: Output envelopes, live transcripts, summaries, and failure details are implemented in part but need consistent attempt-aware behavior. Acceptance criteria: unwrap produced, pending, and failed output envelopes; show partial output and structured error name, code, message, and attempt; distinguish no output from unavailable output; keep live transcript updates bounded and iteration/attempt scoped; add tests for success, pending, failure, and transient fetch errors.

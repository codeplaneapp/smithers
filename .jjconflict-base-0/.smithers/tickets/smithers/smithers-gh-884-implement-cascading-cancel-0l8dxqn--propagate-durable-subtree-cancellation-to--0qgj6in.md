# Propagate durable subtree cancellation to detached owners and agent process trees

GitHub: https://github.com/smithersai/smithers/issues/972

Parent: smithers/gh-884-implement-cascading-cancellation-and-orphan-proces.md

Context: The engine has a per-run cancel watcher, while process-group cleanup currently occurs only when a local spawnCaptureEffect is aborted. Extend cancellation so detached owners and their agent descendants cannot outlive a cancelled parent.

Acceptance criteria:
- An owner that is not present in the cancelling gateway process observes the durable cancellation request and aborts its run and in-flight work.
- Cancellation reaches every descendant owner and agent process, including nested child workflows and detached process groups, with platform-appropriate fallback behavior.
- Continue-as-new or child creation cannot race cancellation to create a new active descendant.
- Cancellation waits for or verifies process-tree reaping and leaves no active owner or agent process for the cancelled subtree.

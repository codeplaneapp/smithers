# Implement and test replay-unsafe approval through the real engine

GitHub: https://github.com/smithersai/smithers/issues/832

Parent: smithers/cov-11-case08-inspector-and-case24-replay-safety-are-hy.md

Context: Case24 locally stubs tool metadata, seeds attempts and events with direct SQL, classifies replay safety in test code, and writes the approval row itself. The engine currently emits only a tool-resume warning. Acceptance criteria: define a real non-idempotent side-effect tool in a real workflow, execute and interrupt or fail an attempt through the engine, resume it through the real product path, persist a native ReplayUnsafeApproval and waiting state, and verify the unsafe tool is not invoked again. Also cover safe idempotent and keyed replay behavior. Do not use hand-written schema, fabricated storage, or test-local replay logic.

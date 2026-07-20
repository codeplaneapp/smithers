# Protect every force-resume path from live drivers

GitHub: https://github.com/smithersai/smithers/issues/1056

Parent: smithers/stall-detection-calls-live-saturated-engine-orphaned.md

Context: Attaching a second engine to a live run can cause split-brain scheduling and racing state writes.

Acceptance criteria:
- All public and automated force-resume paths refuse when the recorded driver PID or lock is alive, unless a separately named override is supplied.
- Refusal leaves the original owner, run state, and task attempts unchanged.
- Add coverage for CLI, engine, and supervisor resume paths.

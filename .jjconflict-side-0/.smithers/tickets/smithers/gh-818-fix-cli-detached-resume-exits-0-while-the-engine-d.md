# 🐛 fix(cli): detached --resume exits 0 while the engine dies on RESUME_METADATA_MISMATCH

GitHub: https://github.com/smithersai/smithers/issues/818

`smithers up <wf> --run-id <id> --resume true --detach` prints runId/logFile/pid and exits 0 even when the forked engine immediately refuses with RESUME_METADATA_MISMATCH and exits. The refusal is only visible in the run log. Detached resume should preflight the metadata check (or wait for the engine's first heartbeat) and fail loudly with the mismatch details.

Observed on run run-1783713026863 after its workflow file was edited: three separate 'successful' resumes, all dead on arrival, diagnosed only via the log tail.

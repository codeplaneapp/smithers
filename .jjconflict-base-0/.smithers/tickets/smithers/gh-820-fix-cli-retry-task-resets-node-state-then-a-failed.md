# 🐛 fix(cli): retry-task resets node state, then a failed engine relaunch orphans the run

GitHub: https://github.com/smithersai/smithers/issues/820

`smithers retry-task` resets the target nodes' attempt state and then starts an engine in-process. If that engine dies (here: RESUME_METADATA_MISMATCH; also any crash), the run is left orphaned with mutated node state and no engine. The reset and the relaunch should be atomic: preflight resumability BEFORE resetting nodes, or roll the reset back when the engine fails to attach.

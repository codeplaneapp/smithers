# Skip dependency-gated timers during engine timer reconciliation

GitHub: https://github.com/smithersai/smithers/issues/835

Fix packages/engine/src/engine.js reconcileTimerWait so it does not call resolveTimerTaskStateBridge for timer tasks whose dependencies or fork source are not yet terminal. This must prevent the bridge from creating an attempt or anchoring a duration timer before the task becomes runnable. Add a regression test covering a dependency chain such as T1 -> agent A -> T2 -> B.

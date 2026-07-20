# Guard timerFired to only complete waiting timers

GitHub: https://github.com/smithersai/smithers/issues/834

Fix packages/scheduler/src/makeWorkflowSession.js so timerFired completes a timer only when its task state is waiting-timer, while tolerating the explicitly supported fire-before-park race for a dispatched timer. Pending timers with unmet dependencies and already-finished timers must not be marked finished or have their outputs overwritten. Add regression tests for both cases.

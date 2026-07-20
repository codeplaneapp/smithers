# Guard scheduler timerFired against non-waiting timers

GitHub: https://github.com/smithersai/smithers/issues/983

Parent: smithers/gh-545-scheduler-engine-dep-gated-timer-gets-its--1yh3hfk.md

Context: makeWorkflowSession.timerFired currently allows any descriptor marked meta.__timer to be finished even when its scheduler state is pending or already finished. This can overwrite completed output or unblock downstream tasks before dependencies complete. Acceptance criteria: timerFired must finish a timer only when its state is waiting-timer, with only the explicitly supported fire-before-park race tolerated; pending timers with unmet dependencies and finished timers must be ignored or re-decided without changing state or output. Add regression tests covering pending and already-finished timer descriptors.

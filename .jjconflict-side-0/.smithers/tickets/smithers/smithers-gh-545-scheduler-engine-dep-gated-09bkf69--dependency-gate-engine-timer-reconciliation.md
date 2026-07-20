# Dependency-gate engine timer reconciliation

GitHub: https://github.com/smithersai/smithers/issues/984

Parent: smithers/gh-545-scheduler-engine-dep-gated-timer-gets-its--1yh3hfk.md

Context: engine.reconcileTimerWait scans every non-terminal timer in lastGraph and invokes resolveTimerTaskStateBridge without checking whether dependsOn prerequisites are terminal. The bridge creates a missing duration-timer attempt immediately, anchoring its deadline before the timer becomes runnable. Acceptance criteria: reconciliation must skip timer descriptors whose dependencies or fork source are not yet satisfied, must not create an attempt or timer anchor for them, and must reconcile them only after they become runnable. Add an integration or engine regression test for a dependency-gated timer proving its duration starts after dependencies complete.

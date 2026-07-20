# Run the two-hour cron soak through the real scheduler

GitHub: https://github.com/smithersai/smithers/issues/829

Parent: smithers/cov-09-six-fault-cases-are-empty-skip-only-stubs-entire.md

Context: e2e/faults/case29-soak-cron-2h-no-stuck.test.ts:52-84 manually mirrors scheduler behavior instead of invoking the production scheduler. Acceptance criteria: drive the real scheduler tick path against real persisted cron data for the simulated two-hour duration; verify no duplicate or stuck firings; retain the opt-in soak gate and use no mocked scheduler behavior.

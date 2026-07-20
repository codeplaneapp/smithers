# Account for lifecycle-linked child runs in concurrency limits

GitHub: https://github.com/smithersai/smithers/issues/885

Make lifecycle-bound child workflows consume the parent run's configured concurrency and subtreeConcurrency budgets. Add admission-control tests proving dynamic fan-out is bounded across parent and descendant runs.

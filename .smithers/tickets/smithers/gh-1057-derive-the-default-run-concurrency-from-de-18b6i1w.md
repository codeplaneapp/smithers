# Derive the default run concurrency from declared Parallel widths

GitHub: https://github.com/smithersai/smithers/issues/1057

Make up/workflow run inspect the statically extracted graph and choose a default engine maxConcurrency at least as wide as the largest declared Parallel maxConcurrency. Preserve explicit --max-concurrency pins and define how the auto-raise ceiling interacts with the derived default. Add an end-to-end test proving a workflow with Parallel maxConcurrency={64} is not capped at the default 4 or auto ceiling solely because no CLI flag was supplied.

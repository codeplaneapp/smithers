# Deduplicate concurrent resume requests per runId

GitHub: https://github.com/smithersai/smithers/issues/859

Add per-runId in-flight resume coordination so timer, signal, approval, and other callers targeting the same parked run share one resume operation and only one startRun(..., { resume: true }) proceeds. Add coverage for concurrent callers and verify the live run remains tracked and cancellable.

# server: deduplicate concurrent resume attempts per runId

GitHub: https://github.com/smithersai/smithers/issues/996

Parent: smithers/gh-675-server-medium-concurrent-resume-orphans-a--0kt69qx.md

Context: resumeRunIfNeeded checks activeRuns, awaits adapter.getRun, and then starts a resumed run. Concurrent timer, signal, approval, or operator paths can pass the check together and invoke startRun with resume:true multiple times for the same runId.

Acceptance criteria:
1. Concurrent resume requests for one runId share or serialize through one in-flight resume operation, so only one startRun(resume:true) and one active AbortController are created.
2. The per-run gate is cleared after success or failure so a later legitimate resume can proceed.
3. A regression test forces the adapter lookup to yield and verifies one engine invocation and one tracked active run.

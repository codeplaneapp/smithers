# Make LlamaParse requests and polling cancellation-aware

GitHub: https://github.com/smithersai/smithers/issues/1040

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: LlamaParse may upload a file, create a job, poll status, and wait between polls; these requests and the one-second polling delay currently ignore cancellation. Acceptance criteria: thread abortSignal through upload, job creation, status requests, and helper functions; replace the polling delay with an abortable wait; preserve success, failure, and timeout behavior; add tests for cancellation during a provider request and during a polling interval.


> Closed by ticket-fleet sync: LlamaParse threads abortSignal through upload, job creation, status polling, and abortableDelay in packages/agents/src/document-parsing/createDocumentParsingToolset.js:204-399. Cancellation tests cover provider-request cancellation, polling-interval cancellation, and signal propagation in packages/agents/tests/document-parsing-llamaparse-abort.test.js:7-140 and document-parsing-cancellation.test.js:67-194. Success, failure, and timeout behavior are tested in coverage-doc-parsing.test.js:120-242. Targeted execution passed: 28 tests, 0 failures.

# Make LlamaParse requests and polling cancellation-aware

GitHub: https://github.com/smithersai/smithers/issues/1040

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: LlamaParse may upload a file, create a job, poll status, and wait between polls; these requests and the one-second polling delay currently ignore cancellation. Acceptance criteria: thread abortSignal through upload, job creation, status requests, and helper functions; replace the polling delay with an abortable wait; preserve success, failure, and timeout behavior; add tests for cancellation during a provider request and during a polling interval.

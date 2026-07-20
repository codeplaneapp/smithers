# Make Firecrawl document parsing requests abortable

GitHub: https://github.com/smithersai/smithers/issues/1038

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: Firecrawl URL scraping and file parsing currently issue POST requests without the AI SDK cancellation signal. Acceptance criteria: thread abortSignal through Firecrawl URL and multipart file parsing into fetch RequestInit.signal; preserve existing request bodies and result normalization; add a cancellation test covering an in-flight Firecrawl request.


> Closed by ticket-fleet sync: Implemented in commit 52f75b2389, which is an ancestor of main. packages/agents/src/document-parsing/createDocumentParsingToolset.js forwards abortSignal through Firecrawl URL scraping and multipart parsing into RequestInit.signal while preserving bodies and result normalization. packages/agents/tests/document-parsing-cancellation.test.js covers an in-flight real Firecrawl request and multipart signal propagation; the test passes with 6 tests and 0 failures. Existing document-parsing-toolset tests cover request bodies and normalized results.

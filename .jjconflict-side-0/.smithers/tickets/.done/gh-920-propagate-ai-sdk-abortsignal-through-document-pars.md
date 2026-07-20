# Propagate AI SDK abortSignal through document parsing providers and polling

GitHub: https://github.com/smithersai/smithers/issues/920

Thread ToolExecutionOptions.abortSignal through custom providers and Firecrawl, Mistral OCR, and LlamaParse requests. Make LlamaParse polling delays abortable and test cancellation during both a provider request and a polling interval.


> Closed by ticket-fleet sync: Implemented and tested. createDocumentParsingToolset passes callOptions.abortSignal to providers, and DocumentParsingProvider types the option. Firecrawl, Mistral OCR, and LlamaParse forward the signal through all requests; LlamaParse polling delays reject immediately on abort. Tests cover custom-provider cancellation, provider-request cancellation, polling-interval cancellation, and signal identity. The five targeted test files passed: 22 tests, 0 failures.

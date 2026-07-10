# Propagate AI SDK abortSignal through document parsing providers and polling

GitHub: https://github.com/smithersai/smithers/issues/920

Thread ToolExecutionOptions.abortSignal through custom providers and Firecrawl, Mistral OCR, and LlamaParse requests. Make LlamaParse polling delays abortable and test cancellation during both a provider request and a polling interval.

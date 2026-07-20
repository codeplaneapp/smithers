# Propagate cancellation through document parsing providers and polling

GitHub: https://github.com/smithersai/smithers/issues/1024

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: Firecrawl, Mistral OCR, and LlamaParse document parsing discard the AI SDK abort signal, and LlamaParse polling delays cannot be interrupted. Acceptance criteria: extend the provider contract to receive execution cancellation; pass the signal through every provider fetch and response operation; make LlamaParse polling delays abortable; add coverage for cancelled never-settling requests and cancelled polling.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/document-parsing/DocumentParsingProvider.ts and createDocumentParsingToolset.js: the provider contract accepts abortSignal, the AI SDK signal is forwarded, and Firecrawl, Mistral OCR, and LlamaParse pass it to all fetch helpers. LlamaParse polling uses an abortable delay. Coverage exists in document-parsing-cancellation.test.js, document-parsing-mistral-abort.test.js, document-parsing-llamaparse-abort.test.js, and document-parsing-custom-provider-abort.test.js, including never-settling requests and cancelled polling. Focused verification passed: 35 tests across 5 files; packages/agents typecheck also passed.

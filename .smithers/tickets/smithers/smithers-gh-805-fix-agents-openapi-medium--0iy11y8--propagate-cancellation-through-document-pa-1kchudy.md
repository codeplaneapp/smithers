# Propagate cancellation through document parsing providers and polling

GitHub: https://github.com/smithersai/smithers/issues/1024

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: Firecrawl, Mistral OCR, and LlamaParse document parsing discard the AI SDK abort signal, and LlamaParse polling delays cannot be interrupted. Acceptance criteria: extend the provider contract to receive execution cancellation; pass the signal through every provider fetch and response operation; make LlamaParse polling delays abortable; add coverage for cancelled never-settling requests and cancelled polling.

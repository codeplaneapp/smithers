# Make Firecrawl document parsing requests abortable

GitHub: https://github.com/smithersai/smithers/issues/1038

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: Firecrawl URL scraping and file parsing currently issue POST requests without the AI SDK cancellation signal. Acceptance criteria: thread abortSignal through Firecrawl URL and multipart file parsing into fetch RequestInit.signal; preserve existing request bodies and result normalization; add a cancellation test covering an in-flight Firecrawl request.

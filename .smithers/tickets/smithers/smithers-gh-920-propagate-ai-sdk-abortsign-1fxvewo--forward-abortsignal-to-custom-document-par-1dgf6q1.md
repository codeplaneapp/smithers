# Forward abortSignal to custom document parsing providers

GitHub: https://github.com/smithersai/smithers/issues/1037

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: The document parsing tool accepts injected providers, but currently calls parseDocument with only normalized input and the provider contract has no cancellation signal. Acceptance criteria: forward AI SDK ToolExecutionOptions.abortSignal to custom providers; update the provider type contract; preserve input normalization and results; add tests verifying the exact signal is received and cancellation rejects promptly.

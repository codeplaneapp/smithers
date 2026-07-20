# Forward abortSignal to custom document parsing providers

GitHub: https://github.com/smithersai/smithers/issues/1037

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: The document parsing tool accepts injected providers, but currently calls parseDocument with only normalized input and the provider contract has no cancellation signal. Acceptance criteria: forward AI SDK ToolExecutionOptions.abortSignal to custom providers; update the provider type contract; preserve input normalization and results; add tests verifying the exact signal is received and cancellation rejects promptly.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/document-parsing/createDocumentParsingToolset.js:68-69, which normalizes input and forwards callOptions.abortSignal to provider.parseDocument. packages/agents/src/document-parsing/DocumentParsingProvider.ts:5-15 updates the provider contract with an optional abortSignal options argument. packages/agents/tests/document-parsing-custom-provider-abort.test.js verifies the exact signal, normalized input, preserved result, prompt rejection through a real pending server request, invalid-input normalization, and no-signal compatibility. Targeted test passed: 4 tests, 0 failures.

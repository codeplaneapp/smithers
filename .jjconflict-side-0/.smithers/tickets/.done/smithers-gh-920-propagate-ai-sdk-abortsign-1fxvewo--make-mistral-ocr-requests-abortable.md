# Make Mistral OCR requests abortable

GitHub: https://github.com/smithersai/smithers/issues/1039

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: Mistral OCR URL, base64 document, and image requests currently call the JSON request helper without a cancellation signal, while text sources are local. Acceptance criteria: thread abortSignal into the Mistral OCR POST request; preserve URL, base64, image, page, instruction, and text-source behavior; add a test proving cancellation aborts a pending OCR request and rejects promptly.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/document-parsing/createDocumentParsingToolset.js:182-186, where Mistral OCR passes parseOptions.abortSignal to postJson; postJson adds it as fetch init.signal at lines 258-267. Tests in packages/agents/tests/document-parsing-mistral-abort.test.js cover prompt URL requests, real-server cancellation with prompt rejection, base64 image signal propagation, page output, and local text behavior. packages/agents/tests/coverage-doc-parsing.test.js covers URL/page normalization, base64 PDF/image handling, and text sources. Targeted tests passed: 21 pass, 0 fail.

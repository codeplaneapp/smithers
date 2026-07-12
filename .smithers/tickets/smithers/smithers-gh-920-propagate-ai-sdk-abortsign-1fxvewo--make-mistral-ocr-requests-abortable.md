# Make Mistral OCR requests abortable

GitHub: https://github.com/smithersai/smithers/issues/1039

Parent: smithers/gh-920-propagate-ai-sdk-abortsignal-through-document-pars.md

Context: Mistral OCR URL, base64 document, and image requests currently call the JSON request helper without a cancellation signal, while text sources are local. Acceptance criteria: thread abortSignal into the Mistral OCR POST request; preserve URL, base64, image, page, instruction, and text-source behavior; add a test proving cancellation aborts a pending OCR request and rejects promptly.

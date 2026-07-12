# document-parsing/

`createDocumentParsingToolset.js` — a `parse_document` AI SDK tool over
pluggable OCR/parsing providers, plus its type sidecars
(`DocumentParsingProvider.ts`, `DocumentParsingResult.ts`,
`DocumentParsingToolset.ts`, `DocumentParsingToolsetOptions.ts`).

Providers:

- `firecrawl` (default) — `/scrape` for URLs, multipart `/parse` for files.
- `mistral-ocr` — data-URL documents.
- `llamaparse` — upload, create job, then poll until COMPLETED (bounded by
  `LLAMAPARSE_POLL_MAX_ATTEMPTS` x `LLAMAPARSE_POLL_INTERVAL_MS`).
- Any injected object matching `DocumentParsingProvider`. Providers are called
  as `parseDocument(input, { abortSignal })` — the AI SDK per-call abort signal
  is forwarded so custom providers can cancel in-flight work.

Input sources are `url | base64 | text`; results normalize to
`{ provider, text, markdown?, pages?, metadata?, raw }`.

Gotcha: API keys fall back to `FIRECRAWL_API_KEY` / `MISTRAL_API_KEY` /
`LLAMA_CLOUD_API_KEY` env vars; requests fail fast when no key resolves.

Exported via the package's `./document-parsing/createDocumentParsingToolset`
entry.

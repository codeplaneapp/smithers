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
- Any injected object matching `DocumentParsingProvider`.

Input sources are `url | base64 | text`; results normalize to
`{ provider, text, markdown?, pages?, metadata?, raw }`.

```ts
import {
  createDocumentParsingToolset,
} from "@smithers-orchestrator/agents/document-parsing/createDocumentParsingToolset";

const documents = createDocumentParsingToolset({
  provider: "firecrawl",
  apiKey: process.env.FIRECRAWL_API_KEY!,
  maxInputBytes: 25 * 1024 * 1024,
  maxResponseBytes: 10 * 1024 * 1024,
});
```

URL sources and provider `baseUrl` values must use HTTP(S) and cannot embed URL
userinfo. Provider redirects are bounded and revalidated at every hop;
sensitive headers stay on the initial origin and same-origin redirects, are
stripped on cross-origin redirects, and request bodies are not replayed to an
untrusted origin. HTTPS-to-HTTP downgrades are rejected. Redirects default to 5
hops (`maxRedirects`); use `allowedOrigins` only for an exact provider redirect
origin that must retain credentials or intentionally reach a private service.
Every other cross-origin redirect hostname must resolve entirely to
public-unicast addresses; `resolveHostname` can inject a resolver for controlled
runtimes and tests. Provider JSON responses default to a
10 MiB cap (`maxResponseBytes`), including each LlamaParse polling response.
The AI SDK tool-call `abortSignal` cancels provider fetches, response reads, and
LlamaParse polling delays.

Decoded base64 and UTF-8 text inputs default to a separate 25 MiB cap
(`maxInputBytes`). The tool validates their byte size before invoking either a
built-in or custom provider, and rejects malformed or oversized base64 before
allocating the decoded payload. URL-source size remains the provider's concern,
so the surrounding workflow must still constrain remote document size and
content type.

Gotcha: API keys fall back to `FIRECRAWL_API_KEY` / `MISTRAL_API_KEY` /
`LLAMA_CLOUD_API_KEY` env vars; requests fail fast when no key resolves.

Exported via the package's `./document-parsing/createDocumentParsingToolset`
entry.

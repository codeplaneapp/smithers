# transcription/

`createTranscriptionTool.js` — Whisper (multipart upload to OpenAI) or
Deepgram (URL or raw bytes) speech-to-text as an AI SDK tool.
`createTranscriptionTool.ts` is the type sidecar (options, input, and result
types).

```ts
import { createTranscriptionTool } from "@smithers-orchestrator/agents";

const transcribe = createTranscriptionTool({
  provider: "whisper",
  apiKey: process.env.OPENAI_API_KEY!,
  allowedAudioHosts: ["media.example.com"],
  maxAudioBytes: 25 * 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
});
```

An agent-supplied `audioUrl` and the operator-configured provider `baseUrl` must
use HTTP(S) and cannot embed URL userinfo. By default the tool rejects
localhost-style names and IP literals outside ordinary public-unicast space.
This includes private, loopback, link-local, shared, benchmarking,
documentation, translation, mapped, multicast, and other IANA non-global
special-purpose ranges. Untrusted hostnames are resolved before the initial
audio download and every redirect; failed or empty resolution and any
non-global A/AAAA answer are denied. `resolveHostname` can inject a resolver in
controlled runtimes and deterministic tests. Fetch performs its own later DNS
resolution, so network egress must still block private ranges, metadata, and
DNS-rebinding races.

`allowedAudioHosts` is the preferred narrow opt-in for an internal or
special-scope media host; `allowPrivateAudioUrl` disables that literal/name
guard and should be reserved for a separately isolated environment.

Audio URL downloads and base64-decoded audio inputs are limited to 25 MiB by
default (`maxAudioBytes`) for both providers. Base64 size and validity are
checked before allocating the decoded audio, so an oversized encoded input
cannot force an oversized decode first. Whisper and Deepgram response bodies
are limited to 1 MiB by default (`maxResponseBytes`). Redirects are bounded and
every target is revalidated; HTTPS-to-HTTP downgrades are rejected, and
provider credentials or request bodies are not forwarded to an untrusted
origin.

Redirects default to 5 hops (`maxRedirects`). Add an exact provider redirect
origin to `allowedOrigins` only when that provider intentionally requires
credentials or private-network access at the destination. Other provider
redirect hostnames must resolve entirely to public-unicast addresses. The AI
SDK tool-call `abortSignal` cancels
audio download, provider requests, and response reads.

Input takes exactly one of `audioUrl | audioBase64`.

`index.js` / `index.ts` re-export the tool and its types; they have no direct
importers but stay reachable through the package's `./*` wildcard export.

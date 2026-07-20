# transcription/

`createTranscriptionTool.js` — Whisper (multipart upload to OpenAI) or
Deepgram (URL or raw bytes) speech-to-text as an AI SDK tool.
`createTranscriptionTool.ts` is the type sidecar (options, input, and result
types).

SSRF guard: an agent-supplied `audioUrl` is rejected for non-http(s) schemes
and for loopback, private, link-local, multicast, reserved, CGNAT, and metadata
addresses. Local Whisper downloads resolve every A and AAAA answer, reject the
whole set if any answer is blocked, and connect a one-off HTTP(S) socket to one
validated numeric address. Every redirect is resolved and pinned again. The
original hostname remains the HTTP Host value and the TLS SNI/certificate
identity. `allowedAudioHosts` is a strict per-hop allowlist;
`allowPrivateAudioUrl` explicitly bypasses only the host/address policy for
private addresses. Scheme checks, pinning, redirect limits, and abort handling
still apply.

For IPv6 destinations, the guard inspects all six RFC 6052 layouts (`/32`,
`/40`, `/48`, `/56`, `/64`, and `/96`) whenever the required u octet is zero.
It cannot rely on DNS64 prefix discovery: a network can advertise NAT64 without
DNS64 or use different prefixes for different IPv4 ranges. Suffix bits are
treated as don't-care, including when non-zero, and an embedded `0.0.0.0`
remains blocked. This deliberately fails closed when an ordinary global IPv6
address is indistinguishable from a translated blocked target. Explicitly add
a trusted hostname to `allowedAudioHosts`, or set `allowPrivateAudioUrl`, to
accept that conservative false positive.

`fetch` is used only for the Whisper or Deepgram provider API request. Tests and
specialized runtimes can inject `audioUrlResolver` and `audioUrlTransport` for
the local Whisper download. Those are trusted security seams: a custom resolver
must return every address. A custom transport must use only the supplied
numeric address, preserve Host and TLS identity, disable pooling, follow no
redirects, and honor the supplied abort signal. `audioUrlMaxRedirects` defaults
to 5 and accepts at most 20.

Deepgram URL input is still handed to Deepgram as JSON. It does not use the
local DNS resolver or pinned transport.

Input takes exactly one of `audioUrl | audioBase64`.

`index.js` / `index.ts` re-export the tool and its types; they have no direct
importers but stay reachable through the package's `./*` wildcard export.

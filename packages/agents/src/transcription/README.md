# transcription/

`createTranscriptionTool.js` — Whisper (multipart upload to OpenAI) or
Deepgram (URL or raw bytes) speech-to-text as an AI SDK tool.
`createTranscriptionTool.ts` is the type sidecar (options, input, and result
types).

SSRF guard: an agent-supplied `audioUrl` is rejected for non-http(s) schemes
and for loopback/private/link-local/CGNAT/metadata hosts (IPv4 and IPv6,
including mapped forms). `allowedAudioHosts` pins an allowlist;
`allowPrivateAudioUrl` opts out of the guard.

Input takes exactly one of `audioUrl | audioBase64`.

`index.js` / `index.ts` re-export the tool and its types; they have no direct
importers but stay reachable through the package's `./*` wildcard export.

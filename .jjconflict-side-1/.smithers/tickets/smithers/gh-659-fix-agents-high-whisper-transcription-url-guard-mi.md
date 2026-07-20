# 🔒 fix(agents): [high] Whisper transcription URL guard misses DNS-to-private SSRF

GitHub: https://github.com/smithersai/smithers/issues/659

via /codex review

**Severity:** High

## Problem
The Whisper transcription tool locally downloads an agent-supplied `audioUrl`, but the SSRF guard only checks the URL's hostname string. It blocks IP literals like `169.254.169.254` and `127.0.0.1`, but it allows any non-local DNS name without resolving it. An attacker-controlled hostname can resolve to a private, loopback, or cloud-metadata address and still be fetched by the Smithers process.

## References
- `packages/agents/src/transcription/createTranscriptionTool.js:87` documents the SSRF guard for `audioUrl`.
- `packages/agents/src/transcription/createTranscriptionTool.js:107` extracts only `url.hostname`.
- `packages/agents/src/transcription/createTranscriptionTool.js:116` allows non-allowlisted DNS names unless `isBlockedAudioHost(host)` matches the string.
- `packages/agents/src/transcription/createTranscriptionTool.js:117` only blocks string/IP-literal hosts.
- `packages/agents/src/transcription/createTranscriptionTool.js:199` performs the local `fetchImpl(input.audioUrl)` for Whisper.

## Failure Scenario
Input to an agent with the transcription tool enabled:

```json
{
  "audioUrl": "https://metadata.attacker.example/latest/meta-data/iam/security-credentials/"
}
```

where `metadata.attacker.example` resolves to `169.254.169.254` or another private address.

Actual behavior: the hostname string is not `localhost`, not `.local`, and not an IP literal, so it passes `assertSafeAudioUrl()`. The Whisper path then fetches that URL locally before uploading the blob to OpenAI.

I verified the control-flow with a stub `fetch`: `http://169.254.169.254/...`, `http://127.0.0.1/...`, and `https://localhost/...` are rejected, but `https://metadata.attacker.example/...` is accepted and appears as the first fetch call before the provider request.

## Why It Matters
This is an agent-callable tool surface. A prompt, document, or user request that controls `audioUrl` can cause the host running Smithers to make HTTP(S) requests into internal networks or cloud metadata services. In hosted or CI environments, that can expose credentials, instance metadata, or internal services.

A safer implementation would either require `allowedAudioHosts` for local downloads, resolve and verify every A/AAAA record before fetching, re-check after redirects, and/or avoid local fetching for URL inputs.


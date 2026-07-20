# 🔒 agents: [high] transcription SSRF guard bypassed by HTTP redirect on Whisper audioUrl fetch

GitHub: https://github.com/smithersai/smithers/issues/665

_via ultracode (Opus multi-agent) review_

## Summary
`assertSafeAudioUrl` only validates the initial agent-supplied URL; the Whisper download follows redirects, so a public host can 302 the fetch into blocked loopback/private/metadata space, defeating the SSRF guard.

## Location
- `packages/agents/src/transcription/createTranscriptionTool.js:199` — `await fetchImpl(input.audioUrl)` with no options (default `redirect: "follow"`).
- Guard: `packages/agents/src/transcription/createTranscriptionTool.js:97-120` (validates only `rawUrl`, once).

## Failure scenario
Default config (no `allowedAudioHosts`, no `allowPrivateAudioUrl`). An LLM (or prompt-injected content) calls the tool with `audioUrl="https://attacker.example/a.mp3"`. The public host passes `assertSafeAudioUrl`. The attacker server replies `302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>` (or any RFC1918/loopback service). `fetch` follows the redirect from the orchestrator host and downloads the response body, which is then POSTed to Whisper. This is a blind SSRF into internal/metadata endpoints — precisely what the guard's doc comment (lines 87-92) exists to prevent. (Deepgram path at line 228 hands the URL to Deepgram's server, so this redirect hole is specific to the local Whisper fetch at line 199.)

## Why it matters
Breaks a security control written specifically to block SSRF. Lets the orchestrator host reach cloud metadata (169.254.169.254) and internal loopback/RFC1918 services with an attacker-chosen path.

## Fix
Fetch with `redirect: "manual"` and re-run `assertSafeAudioUrl` on each hop's `Location` (or resolve and pin the final IP before fetching). Note the same guard also does not resolve DNS names, so a public name resolving to a private IP is a related gap worth closing in the same fix.
---

**Relationship to #659:** #659 covers the DNS→private-IP rebinding vector against the same guard. This is a *distinct* bypass — a public host that passes the guard then issues an HTTP **redirect** into blocked space, which `fetch`'s default `redirect:"follow"` transparently chases. The fixes differ (redirect:"manual" + re-validate each hop, vs. pin the resolved connect IP), so both vectors need closing; filing separately for tracking — merge if preferred.


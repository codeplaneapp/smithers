# Harden ElevenLabs TTS redirects against xi-api-key leakage

GitHub: https://github.com/smithersai/smithers/issues/1020

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: packages/agents/src/createElevenLabsTextToSpeechTool.js sends xi-api-key through fetch. Acceptance criteria: validate every redirect hop and retain xi-api-key only for the authorized ElevenLabs origin, preserve same-origin redirects, and add tests proving cross-origin and multi-hop redirects do not receive the key.


> Closed by ticket-fleet sync: Implemented in commit 52ce83f553. packages/agents/src/createElevenLabsTextToSpeechTool.js:161-222 manually follows and validates every redirect, sends xi-api-key only when currentUrl.origin matches the authorized origin, and preserves same-origin behavior. packages/agents/tests/elevenlabs-tts-redirects.test.js:103-167 covers same-origin, cross-origin, multi-hop, loop, and unsupported-protocol cases; focused test passed 5/5.

# Prevent cross-origin xi-api-key leakage in ElevenLabs text-to-speech

GitHub: https://github.com/smithersai/smithers/issues/917

Update packages/agents/src/createElevenLabsTextToSpeechTool.js to use manual or validated redirects so xi-api-key is only sent to authorized ElevenLabs destinations. Add two-server tests for blocked cross-origin redirects, supported same-origin redirects, and validation of every hop.


> Closed by ticket-fleet sync: packages/agents/src/createElevenLabsTextToSpeechTool.js:161-222 manually follows redirects, validates every HTTP(S) Location, limits hops, and adds xi-api-key only for the authorized origin. packages/agents/tests/elevenlabs-tts-redirects.test.js:42-168 uses real authorized and attacker Bun servers to verify same-origin redirects, cross-origin key removal, multi-hop validation, loop limits, and unsupported protocols. Targeted test passed: 5 tests, 21 expectations, 0 failures.

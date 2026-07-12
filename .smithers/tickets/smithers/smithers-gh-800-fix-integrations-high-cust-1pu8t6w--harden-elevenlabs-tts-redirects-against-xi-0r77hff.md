# Harden ElevenLabs TTS redirects against xi-api-key leakage

GitHub: https://github.com/smithersai/smithers/issues/1020

Parent: smithers/gh-800-fix-integrations-high-custom-api-key-heade-1i4qvww.md

Context: packages/agents/src/createElevenLabsTextToSpeechTool.js sends xi-api-key through fetch. Acceptance criteria: validate every redirect hop and retain xi-api-key only for the authorized ElevenLabs origin, preserve same-origin redirects, and add tests proving cross-origin and multi-hop redirects do not receive the key.

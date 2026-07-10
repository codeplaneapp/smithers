# Prevent cross-origin xi-api-key leakage in ElevenLabs text-to-speech

GitHub: https://github.com/smithersai/smithers/issues/917

Update packages/agents/src/createElevenLabsTextToSpeechTool.js to use manual or validated redirects so xi-api-key is only sent to authorized ElevenLabs destinations. Add two-server tests for blocked cross-origin redirects, supported same-origin redirects, and validation of every hop.

# Propagate abortSignal through Whisper and Deepgram transcription

GitHub: https://github.com/smithersai/smithers/issues/1027

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: transcription tools accept only input and omit cancellation from audio downloads and provider requests. Acceptance criteria: accept ToolExecutionOptions in execute; pass the signal to Whisper audio download and transcription fetches and to Deepgram fetches; ensure cancellation rejects promptly and cancels the active request; add tests for both providers and the Whisper audio-download path.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/transcription/createTranscriptionTool.js:49-58, with abortSignal passed to Whisper download/transcription fetches at lines 202 and 208-213 and Deepgram at lines 240-246. Tests in packages/agents/tests/transcription-tool.test.js cover both providers, pre-aborted signals, in-flight cancellation, and Whisper audio-download cancellation (lines 120-186 and 260-338). Targeted test run passed: 18 tests, 0 failures.

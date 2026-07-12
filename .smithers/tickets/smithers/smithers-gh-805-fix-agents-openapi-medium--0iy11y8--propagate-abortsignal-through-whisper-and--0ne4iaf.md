# Propagate abortSignal through Whisper and Deepgram transcription

GitHub: https://github.com/smithersai/smithers/issues/1027

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: transcription tools accept only input and omit cancellation from audio downloads and provider requests. Acceptance criteria: accept ToolExecutionOptions in execute; pass the signal to Whisper audio download and transcription fetches and to Deepgram fetches; ensure cancellation rejects promptly and cancels the active request; add tests for both providers and the Whisper audio-download path.

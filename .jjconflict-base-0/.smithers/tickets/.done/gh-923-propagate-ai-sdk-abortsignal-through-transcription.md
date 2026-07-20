# Propagate AI SDK abortSignal through transcription downloads and provider calls

GitHub: https://github.com/smithersai/smithers/issues/923

Thread abortSignal through Whisper audio downloads, Whisper transcription requests, and Deepgram requests. Add cancellation tests for URL download and provider submission paths that verify underlying fetch cancellation and prompt rejection.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/transcription/createTranscriptionTool.js:49-59, 192-248: execute reads abortSignal and passes it to Whisper audio download, Whisper submission, and Deepgram requests. packages/agents/tests/transcription-tool.test.js covers exact signal forwarding, pre-aborted rejection, real-server cancellation for Whisper submission, Whisper URL download, and Deepgram. Targeted test run passed: 18 tests, 0 failures.

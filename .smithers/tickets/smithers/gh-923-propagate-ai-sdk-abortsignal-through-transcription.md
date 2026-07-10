# Propagate AI SDK abortSignal through transcription downloads and provider calls

GitHub: https://github.com/smithersai/smithers/issues/923

Thread abortSignal through Whisper audio downloads, Whisper transcription requests, and Deepgram requests. Add cancellation tests for URL download and provider submission paths that verify underlying fetch cancellation and prompt rejection.

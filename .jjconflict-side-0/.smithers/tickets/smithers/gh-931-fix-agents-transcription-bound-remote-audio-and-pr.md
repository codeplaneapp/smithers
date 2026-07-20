# 🐛 fix(agents/transcription): bound remote audio and provider response bodies

GitHub: https://github.com/smithersai/smithers/issues/931

Add a configurable maximum response size to createTranscriptionTool. Enforce it while downloading audioUrl content before creating the Whisper File, and while reading Whisper and Deepgram JSON responses. Reject oversized Content-Length values, abort and clean up on chunked overflow, and test declared oversize, chunked overflow, exact-at-cap responses, and cancellation.

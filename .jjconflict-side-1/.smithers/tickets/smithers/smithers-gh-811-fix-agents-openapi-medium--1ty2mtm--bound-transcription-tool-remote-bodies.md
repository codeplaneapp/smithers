# Bound transcription tool remote bodies

GitHub: https://github.com/smithersai/smithers/issues/1115

Parent: smithers/gh-811-fix-agents-openapi-medium-network-tools-fu-1it0l6q.md

Context: createTranscriptionTool fully buffers agent-supplied Whisper audio URLs with response.blob() and buffers Whisper and Deepgram results with response.json(), without response-size limits. Acceptance criteria: Add a conservative configurable byte limit covering remote audio downloads and provider responses; reject oversized declared Content-Length before buffering; enforce the limit while streaming chunked bodies; cancel the response/body on overflow; preserve successful transcription at or below the cap and existing abort-signal behavior; add tests for declared-length overflow, chunked audio/provider-response overflow, exact-cap responses, and cleanup after overflow.

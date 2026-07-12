# Bound createHttpTool response bodies

GitHub: https://github.com/smithersai/smithers/issues/1114

Parent: smithers/gh-811-fix-agents-openapi-medium-network-tools-fu-1it0l6q.md

Context: The generic agent HTTP tool accepts model-selected URLs and fully buffers final response bodies with response.text(), allowing oversized or endless responses to exhaust process memory. Acceptance criteria: Add a conservative configurable maximum response size with a default; reject responses whose declared Content-Length exceeds the cap before reading; stream chunked bodies while counting bytes; cancel the response reader/body when the cap is exceeded; preserve JSON and text parsing for responses at or below the cap; add tests for oversized declared length, chunked overflow, exactly-at-cap data, and cancellation/cleanup after overflow.

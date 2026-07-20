# Bound OpenAPI tool response bodies

GitHub: https://github.com/smithersai/smithers/issues/1116

Parent: smithers/gh-811-fix-agents-openapi-medium-network-tools-fu-1it0l6q.md

Context: Generated OpenAPI tools fully buffer every response with response.json() or response.text(), so a remote endpoint can exhaust memory before returning a tool result or HTTP error. Acceptance criteria: Add a conservative configurable response-size limit to OpenApiToolsOptions; reject oversized declared Content-Length before reading; stream and count chunked responses; cancel the reader/body on overflow; preserve JSON/text parsing and non-2xx error handling at or below the cap; retain external abort propagation; add tests for declared-length overflow, chunked overflow, exactly-at-cap responses, and cancellation/cleanup after overflow.

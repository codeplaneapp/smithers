# 🐛 fix(agents/http): bound generic HTTP tool response bodies

GitHub: https://github.com/smithersai/smithers/issues/930

Add a configurable maximum response size to createHttpTool and enforce it for text and JSON responses. Reject oversized Content-Length values before buffering, enforce the limit while reading chunked bodies, cancel and clean up on overflow, and add tests for declared oversize, chunked oversize, exact-at-cap responses, and cancellation.

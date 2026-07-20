# 🔒 fix(openapi): reject non-HTTP server and base URL schemes

GitHub: https://github.com/smithersai/smithers/issues/912

Validate the resolved OpenAPI base/server URL before executeRequest calls fetch. Allow only http: and https:, return the generated tool's typed error result for non-HTTP schemes, and add tests for file:, data:, and other schemes while preserving HTTP/HTTPS execution.

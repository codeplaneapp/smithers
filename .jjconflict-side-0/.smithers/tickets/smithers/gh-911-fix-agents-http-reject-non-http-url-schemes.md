# 🔒 fix(agents/http): reject non-HTTP URL schemes

GitHub: https://github.com/smithersai/smithers/issues/911

Validate the generic HTTP tool URL scheme before applying headers or calling fetch. Allow only http: and https:, return a typed tool error for file:, data:, ftp:, and other schemes, and add Bun tests covering rejection and normal HTTP/HTTPS execution.

# 🐛 fix(openapi): bound executeRequest response bodies

GitHub: https://github.com/smithersai/smithers/issues/932

Add a configurable maximum response size to OpenApiToolsOptions and executeRequest. Replace unbounded response.json()/response.text() consumption with early Content-Length validation and bounded streaming that cancels on overflow, while preserving non-2xx status and body error behavior. Add tests for declared oversize, chunked overflow, exact-at-cap responses, and cleanup.

# Propagate custom headers through collection API and SSE clients

GitHub: https://github.com/smithersai/smithers/issues/905

Extend the data-client options and request construction to merge custom headers with content type and bearer authentication for API requests, fetch-based SSE, and EventSource. Wire these headers from SmithersGatewayProvider and test consistent authorization across RPC, API, and SSE.

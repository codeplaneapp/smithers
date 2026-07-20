# Dispose provider-owned clients when replaced or unmounted

GitHub: https://github.com/smithersai/smithers/issues/906

Track ownership in SmithersGatewayProvider and close obsolete provider-created RPC/data clients when options or clients change, and on unmount, without closing caller-supplied clients. Add lifecycle tests covering replacement and cleanup.

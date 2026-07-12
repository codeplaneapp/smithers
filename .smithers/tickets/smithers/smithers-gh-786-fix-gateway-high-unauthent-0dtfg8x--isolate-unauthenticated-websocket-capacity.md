# Isolate unauthenticated WebSocket capacity

GitHub: https://github.com/smithersai/smithers/issues/1008

Parent: smithers/gh-786-fix-gateway-high-unauthenticated-websocket-0for0ij.md

Context: Pre-authenticated sockets currently share the authenticated connection set and can consume all maxConnections slots. Acceptance criteria: track pre-authenticated sockets separately; enforce a bounded pre-auth capacity; define and implement promotion from pre-auth to authenticated capacity; release both forms of accounting on close or failed authentication; add tests covering the pre-auth cap, promotion, and slot release.

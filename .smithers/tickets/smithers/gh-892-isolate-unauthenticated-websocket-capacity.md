# Isolate unauthenticated WebSocket capacity

GitHub: https://github.com/smithersai/smithers/issues/892

Track pre-authenticated WebSocket sockets separately from authenticated connections and enforce a small bounded pre-auth cap so idle unauthenticated clients cannot exhaust maxConnections. Define promotion from pre-auth to authenticated capacity and release accounting on close, with coverage for the cap and slot release.

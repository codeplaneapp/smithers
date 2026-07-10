# Include all behavior-affecting options in gateway provider recreation semantics

GitHub: https://github.com/smithersai/smithers/issues/904

Update SmithersGatewayProvider so changes to headers, fetch, WebSocket, and client metadata recreate the owned RPC client while stable inline options do not. Add tests proving rotated transports, headers, and metadata are used on subsequent requests.

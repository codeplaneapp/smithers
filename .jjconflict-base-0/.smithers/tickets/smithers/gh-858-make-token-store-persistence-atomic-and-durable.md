# Make token-store persistence atomic and durable

GitHub: https://github.com/smithersai/smithers/issues/858

Update writeSmithersTokenStore() to write mode-0600 data to a temporary file, flush/sync it as appropriate, and atomically rename it over tokens.json, with cleanup/error handling. Add tests covering atomic replacement, permissions, and protection against partial writes.

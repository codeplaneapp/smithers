# Preserve docs filter and deletion semantics in multiplayer

GitHub: https://github.com/smithersai/smithers/issues/900

Make the multiplayer docs collection honor kind, includeDeleted, updatedAfterMs, and limit. Enforce the same live-row behavior as listDocs, including deleted_at_ms IS NULL when includeDeleted is false, or fall back to the RPC query collection when Electric cannot safely express the request.

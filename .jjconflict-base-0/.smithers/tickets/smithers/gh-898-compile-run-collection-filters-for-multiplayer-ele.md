# Compile run collection filters for multiplayer Electric

GitHub: https://github.com/smithersai/smithers/issues/898

Update the multiplayer runs collection to honor ListRunsRequest.filter.status and filter.workflow through validated Electric predicates, and handle filter.limit or use the RPC-backed query collection when Electric cannot safely represent the request. Add local/multiplayer parity tests for status, workflow, and limit.

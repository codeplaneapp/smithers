# Require explicit confirmation for time_travel MCP tool

GitHub: https://github.com/smithersai/smithers/issues/862

Add an explicit confirm=true guard to the time_travel MCP input schema and handler for all run states, while preserving the separate force guard for running runs; update the description and add tests proving completed and failed runs cannot be time-traveled without confirmation and confirmed calls proceed.

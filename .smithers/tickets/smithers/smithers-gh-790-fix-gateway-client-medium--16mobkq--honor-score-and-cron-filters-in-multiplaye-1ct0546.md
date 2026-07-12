# Honor score and cron filters in multiplayer collections

GitHub: https://github.com/smithersai/smithers/issues/1016

Parent: smithers/gh-790-fix-gateway-client-medium-multiplayer-coll-0w5zwp2.md

Context: Multiplayer scores ignore nodeId and crons ignore workflow, despite both fields participating in collection cache keys and RPC requests. Compile runId/nodeId and cron workflow into safe Electric predicates or fall back to RPC-backed collections. Acceptance criteria: scores return only the requested run and optional node; crons return only the requested workflow; local and multiplayer results match on a seeded multi-row dataset; regression tests cover filtered and unfiltered requests.

# Implement cascading cancellation and orphan process reaping

GitHub: https://github.com/smithersai/smithers/issues/884

Implement recursive cancellation for a run subtree, including live, waiting, paused, and stale descendants. Ensure durable cancel requests stop detached owners and their agent process trees, and add real integration tests proving parent cancellation leaves no active child runs or agents.

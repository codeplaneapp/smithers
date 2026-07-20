# Keep the stale gateway-disconnect duration current with render caching

GitHub: https://github.com/smithersai/smithers/issues/844

Ensure the stale gateway-disconnect banner's elapsed seconds do not freeze while cached lines are reused, either by excluding time-dependent output from the cache or using a short cache TTL. Add a regression test that advances time and verifies the displayed duration changes without store activity.

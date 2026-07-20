# Make Monitor loading, empty, and last-known states honest

GitHub: https://github.com/smithersai/smithers/issues/1042

Parent: smithers/smithers-gh-855-add-complete-monitor-loadi-0h89cz9--make-gateway-disconnection-and-recovery-st-0z3jdjw.md

Context: The Monitor can render the landing table’s “No runs match” empty state when the gateway has not connected or has failed, while cached data is not consistently identified as stale. Acceptance criteria: 1. Initial connection failure is never presented as an empty workspace. 2. Loading/connecting, true empty results, offline-with-cache, and offline-without-cache have distinct messages. 3. Offline views clearly label all displayed data as last-known and never imply it is current. 4. Unauthorized has a dedicated state. 5. Add tests for each landing-state transition.

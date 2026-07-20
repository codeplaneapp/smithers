# Add end-to-end Monitor connection recovery coverage

GitHub: https://github.com/smithersai/smithers/issues/1044

Parent: smithers/smithers-gh-855-add-complete-monitor-loadi-0h89cz9--make-gateway-disconnection-and-recovery-st-0z3jdjw.md

Context: Existing tests cover generic gateway transport behavior and a reusable ConnectionBadge, but not the complete Monitor surface required by this ticket. Acceptance criteria: 1. Exercise connecting, live, offline, and unauthorized Monitor states against real gateway behavior. 2. Verify initial connection failure is not an empty-workspace result. 3. Verify cached data is labeled last-known while offline. 4. Drop and restore the gateway connection and verify recovery to live data without losing selection or filters. 5. Keep the tests based on real gateway/server behavior rather than fabricated UI data.

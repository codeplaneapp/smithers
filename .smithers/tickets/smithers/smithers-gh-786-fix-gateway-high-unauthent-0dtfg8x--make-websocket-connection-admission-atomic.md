# Make WebSocket connection admission atomic

GitHub: https://github.com/smithersai/smithers/issues/1009

Parent: smithers/gh-786-fix-gateway-high-unauthenticated-websocket-0for0ij.md

Context: The upgrade handler checks this.connections.size and then asynchronously calls handleUpgrade, so concurrent upgrades can pass the check before any socket is registered. Acceptance criteria: reserve connection capacity synchronously during upgrade admission; reject upgrades when active connections plus reservations reach maxConnections; release reservations on failed upgrades and disconnects; add a concurrent-upgrade test proving the cap is never exceeded.

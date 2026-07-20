# Make WebSocket connection admission atomic

GitHub: https://github.com/smithersai/smithers/issues/893

Reserve connection capacity synchronously during upgrade admission before handing the socket to asynchronous WebSocket processing, then release reservations on failed upgrades or disconnects. Add a concurrent-upgrade test proving the gateway never exceeds maxConnections.

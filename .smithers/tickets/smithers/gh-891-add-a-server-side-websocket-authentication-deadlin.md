# Add a server-side WebSocket authentication deadline

GitHub: https://github.com/smithersai/smithers/issues/891

Start an authentication timer immediately after WebSocket upgrade, close sockets that do not complete a valid connect RPC before the deadline, clear the timer after authentication, and ensure timeout cleanup releases the connection slot. Add tests proving a silent socket closes and a valid client can connect afterward.

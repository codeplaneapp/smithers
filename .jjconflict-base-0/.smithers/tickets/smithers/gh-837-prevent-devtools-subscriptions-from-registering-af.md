# Prevent DevTools subscriptions from registering after WebSocket close

GitHub: https://github.com/smithersai/smithers/issues/837

Update the streamDevTools path so a connection closed while resolveRun or getLastFrame is awaited cannot enter devtoolsSubscribers afterward. Recheck liveness before registration, abort and clean up immediately when closed, and add a regression test verifying the class-level subscriber map and polling loop are cleared.

# Prevent extension stream subscriptions from registering after WebSocket close

GitHub: https://github.com/smithersai/smithers/issues/838

Update subscribeExtensionStream so a connection closed while the extension subscribe handler is awaited cannot be inserted into extensionStreamSubscriptions afterward. Abort the per-stream controller and run the handler cleanup callback immediately, then add a regression test covering cleanup during the subscribe await.

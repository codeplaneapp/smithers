# Prevent run-event subscriptions from registering after WebSocket close

GitHub: https://github.com/smithersai/smithers/issues/836

Update the streamRunEvents path so a connection closed while resolveRun is awaited cannot register a run-event subscriber afterward. Recheck connection liveness before registration, abort or clean up immediately when closed, and add a regression test covering the close-mid-resolve race.

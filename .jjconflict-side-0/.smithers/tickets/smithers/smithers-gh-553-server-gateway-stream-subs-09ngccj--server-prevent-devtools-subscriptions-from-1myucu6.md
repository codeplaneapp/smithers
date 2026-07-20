# server: prevent DevTools subscriptions from registering after WebSocket close

GitHub: https://github.com/smithersai/smithers/issues/986

Parent: smithers/gh-553-server-gateway-stream-subscriptions-regist-0ok3jux.md

Context: streamDevTools awaits resolveRun and, when resuming, getLastFrame before registering its subscriber. A close during either await can leave a class-level devtoolsSubscribers entry and polling loop with an un-aborted signal. Acceptance criteria: re-check connection liveness after all pre-registration awaits; abort and clean up immediately instead of registering when closed; leave devtoolsSubscribers, per-run counts, and polling work empty; add a regression test covering close during the awaits.

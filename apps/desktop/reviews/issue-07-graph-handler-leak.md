# Graph view registers global handlers on every render

Severity: Medium

Location: `src/webview/app.ts:1534`

Description:
`attachGraphHandlers` adds `window` `mousemove`/`mouseup` listeners every time the graph is rendered and never removes them. Re-rendering the inspector accumulates handlers.

Impact:
Leads to memory leaks and duplicated event handling over time.

Suggested Fix:
Use a single global handler or register/unregister on mount/unmount. Consider using `AbortController` to clean up listeners when re-rendering.

# Debug overlays are present in production UI

Severity: Low

Location: `src/webview/app.ts:535`, `views/main/index.html:23`

Description:
Debug banners and debug DOM nodes are always created and shown on load. These leak error details to end users and clutter the UI.

Impact:
User-facing UI noise and potential information disclosure in release builds.

Suggested Fix:
Gate debug UI behind a development flag or remove it for production builds.

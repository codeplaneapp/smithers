# XSS via innerHTML in workflow/run rendering

Severity: High

Location: `src/webview/app.ts:750`, `src/webview/app.ts:818`, `src/webview/app.ts:890`, `src/webview/app.ts:985`, `src/webview/app.ts:1190`

Description:
Dynamic workflow/run/node values are interpolated directly into `innerHTML` without escaping. If a workflow name, node id, or path contains HTML or script, it can execute in the webview context.

Impact:
A malicious or untrusted workspace can trigger XSS in the desktop app. Because the webview has RPC access, this can pivot to privileged actions (e.g., tool execution).

Suggested Fix:
Render dynamic content with DOM APIs (`textContent`) or apply a centralized HTML escape to all interpolated values before setting `innerHTML`.

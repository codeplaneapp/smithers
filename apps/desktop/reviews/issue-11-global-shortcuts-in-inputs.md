# Global shortcuts fire while typing in inputs

Severity: Low

Location: `src/webview/app.ts:1431`

Description:
`handleShortcuts` processes global keyboard shortcuts without checking the focused element. Shortcuts can trigger while the user is typing in inputs or textareas.

Impact:
Unexpected UI actions and potential data loss (e.g., opening dialogs or canceling runs while typing).

Suggested Fix:
Ignore shortcuts when focus is inside editable elements (input, textarea, contenteditable).

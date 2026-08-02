# Replace monitor overlays with shared Dialog primitives

GitHub: https://github.com/smithersai/smithers/issues/1035

Parent: smithers/gh-850-apply-the-shared-smthrs-ui-design-s.md

Context: The hijack terminal and custom workflow UI are rendered through custom mon-modal-backdrop and mon-modal containers. Acceptance criteria: use the shared Dialog anatomy for both overlays with accessible title/description semantics, focus management, Escape handling, overlay dismissal, and close controls; preserve iframe and xterm lifecycle/cleanup behavior; add tests covering open, close, Escape, focus, and terminal-modal rendering.

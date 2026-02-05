# Smithers Desktop (Phases 1-4)

This folder contains an Electrobun desktop shell with a pi-web-ui ChatPanel, Smithers workflow panel, approvals, and basic visualization.

## Quick Start

```bash
cd apps/desktop
bun install
bun run build:webview
bun run start
```

## Tool Commands (Chat)

The Phase 1 agent supports explicit tool commands for testing tool rendering:

- `/read path/to/file`
- `/write path/to/file` then newline + content
- `/edit path/to/file` then newline + unified diff patch
- `/bash <command>`

These commands execute in a sandbox rooted at the current working directory.

## Notes

- Chat sessions are persisted in `smithers-desktop.db` in the app working directory.
- The agent is a minimal stub that echoes text and streams in small chunks.
- Network access is blocked for `bash` commands by simple string checks.

This implementation covers the full UI spec: runs/workflows list, approvals, graph/timeline/logs, outputs, and attempts.

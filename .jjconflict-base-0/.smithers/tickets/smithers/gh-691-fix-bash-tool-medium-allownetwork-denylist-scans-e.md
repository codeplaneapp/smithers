# 🐛 fix(bash-tool): [medium] allowNetwork denylist scans every arg token, blocking benign local commands

GitHub: https://github.com/smithersai/smithers/issues/691

_via ultracode (Opus multi-agent) review_

## Summary
`assertNetworkAllowed` tokenizes all of `[cmd, ...args]` by whitespace and matches network keywords against every token — including the text of string arguments — so purely-local commands that merely mention curl/wget/npm/bun/pip, a URL, or a git remote verb are rejected before execution.

## Location
- `packages/smithers/src/tools/bash.js:148` (token construction over `[cmd, ...args]`)
- `packages/smithers/src/tools/bash.js:151-159` (executable/URL checks over all tokens)
- `packages/smithers/src/tools/bash.js:166-174` (git remote-op check over all tokens)
- Default path: `allowNetwork` defaults to `false` (`packages/smithers/src/tools/utils.js:20`).

## Failure scenario (allowNetwork:false, the default)
- `bashTool("echo", ["please run npm install"])` -> token `npm` basename matches -> throws `TOOL_NETWORK_DISABLED`.
- `bashTool("git", ["commit","-m","fetch upstream changes"])` -> `git` present + token `fetch` -> throws `TOOL_GIT_REMOTE_DISABLED`.
- `bashTool("git", ["commit","-m","see https://x"])` -> token starts with `https://` -> throws `TOOL_NETWORK_DISABLED`.

None perform network I/O, yet all are rejected.

## Why it matters
Sandboxed workflows routinely write commit messages, echo docs, or grep/sed over text containing these ubiquitous words; the denylist yields confusing false-positive failures for local operations. Per the file's own comments (lines 24-26, 50-51) the denylist is bypassable defense-in-depth, not real isolation, so the over-broad matching adds friction without adding security. The check should match the resolved executable(s) and genuine URL arguments, not every whitespace-delimited token of every argument.

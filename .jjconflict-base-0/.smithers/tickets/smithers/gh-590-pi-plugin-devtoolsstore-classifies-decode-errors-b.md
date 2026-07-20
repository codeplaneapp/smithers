# 🧹 pi-plugin: DevToolsStore classifies decode errors by message substring instead of SmithersError code

GitHub: https://github.com/smithersai/smithers/issues/590

**What happens**
`DevToolsStore.consumeStream` (packages/pi-plugin/src/runtime/DevToolsStore.ts:542) detects decode failures with `err.message.includes("DevTools event")` to reset `nextAfterSeq` (full resync) and bump `decodeErrorCount`. The thrower is `DevToolsClient.normalizeEvent`, which uses `SmithersError("PI_DEVTOOLS_DECODE_ERROR", ...)` (DevToolsClient.ts:113, 139).

**Why it matters**
Both current messages happen to contain "DevTools event", so behavior is correct today — but any rewording of either message (or a new decode-error site phrased differently) silently breaks the full-resync-on-decode-error path: the stream resumes from a possibly-bad seq and decodeErrorCount stops counting. SmithersError also appends a docs URL to `message`, making string matching doubly fragile.

**Expected**
Match on the machine-readable signal: `err instanceof SmithersError && err.code === "PI_DEVTOOLS_DECODE_ERROR"`.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).

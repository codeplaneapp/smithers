# @smthrs/mcp

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `@smthrs/mcp`: a stdio MCP client (`McpClient`) and a
  `FlowBinding.Source` projector (`McpFlows`) that turns a connected server's
  tool catalog into one flow per tool, so an MCP tool call is an ordinary flow
  call with no second registration path alongside `@smthrs/std`'s filesystem and
  shell flows.
- Added negotiation of the `initialize` result: the server's `protocolVersion`
  must be one this client decodes and its `capabilities.tools` must be present
  before the handshake completes.
- Added `tools/list` pagination, following `nextCursor` across pages under a
  page cap, with duplicate names rejected across the whole catalog.
- Added bounds on what an untrusted server can size: `maxTools`,
  `maxToolNameBytes`, `maxCatalogPages`, `maxOutboundFrameBytes`, and
  `maxStderrBytes`, each with an exported default constant.
- Added `include`, `exclude`, and `namePrefix` projection options so a host
  chooses which of a server's tools reach the model and under what names.
- Added `notifications/cancelled` for a timed-out or interrupted `tools/call`,
  so remote work declared `irreversible` is not abandoned mid-flight.
- Added pass-through of MCP 2025-06-18 structured tool output: a tool's
  `outputSchema` on `ToolDescription` and `structuredContent` on `ToolResult`
  and on the flow's own `Result` schema.
- Added package-owned documentation under `docs/`, generated into
  `docs/reference.md` by `scripts/docs.mjs`.

### Changed

- Declare authority as one exact `namespace:operation:resource` string per
  `Capability.Action`, derived from `Capability.Action.literals` and frozen. The
  bare `"*"` this module used to declare parsed as nothing, and an unparseable
  declaration is treated as unauthorized, so every MCP tool was refused with
  `capability_refused` before it ran even under an unrestricted envelope.
- Close the stdio transport without racing a separate terminal signal.
- Identify to remote servers as `smithers` at this package's version rather than
  as `flows` at `0.1.0`.
- Drain the child's stderr into a bounded tail and append it to `spawn_failed`,
  `timeout`, and `connection_closed` messages, so a startup failure explains
  itself instead of surfacing as an unexplained handshake deadline.

### Fixed

- Merge `env` into the inherited child environment instead of replacing it. A
  server spawned with a credential received no `PATH`, so the canonical
  `{ command: "npx", env: { TOKEN } }` entry failed to spawn at all.
- Validate every JSON-RPC envelope before correlating it: a reply must carry a
  valid id and exactly one of `result` or `error`, and an error must carry an
  integer code and a string message. An `error: null` reply used to kill the
  reader fiber and hang every pending request until its deadline.
- Map a JSON-RPC error by the method that failed, keeping the numeric code in
  the message, instead of reporting every failure as `tool_failed`.
- Decode `tools/list` and `tools/call` payloads instead of casting them. A
  `null` catalog entry used to throw a `TypeError` out of the declared error
  channel, a non-object content block used to surface as a flow-authored schema
  failure that named no server, and a missing `inputSchema` used to be
  fabricated rather than rejected.
- Reject duplicate tool names at the adapter. A server that repeated a name used
  to fail the host's entire flow catalog, including flows unrelated to MCP.
- Snapshot tool arguments to plain JSON before a request id is registered, so a
  getter, a proxy, a cycle, or a non-finite number fails with a typed error and
  a bounded path instead of a defect.
- Bound the `notifications/initialized` step by `handshakeTimeoutMs` rather than
  by the 120 second tool-call deadline.

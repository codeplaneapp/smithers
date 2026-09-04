---
title: "Bound an untrusted server"
description: "The nine limits McpClient enforces on a remote server, their default values, what each one protects, and the rules a tool name must satisfy."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/bound-an-untrusted-server.md"
---

The server sizes the frames it sends, the catalog it declares, and the flow
names a model reads. All three are inputs from a process you do not control, so
every one of them is bounded, and every bound is an option with an exported
default constant.

You rarely need to change these. Read this page when a real server trips one, or
when you are deciding what to allow a server you do not trust.

## The nine limits

| Option                  | Default | Constant                                 | What it bounds                                      |
| ----------------------- | ------- | ---------------------------------------- | --------------------------------------------------- |
| `handshakeTimeoutMs`    | 10000   | `McpClient.defaultHandshakeTimeoutMs`    | Each `initialize` and `tools/list` exchange.        |
| `requestTimeoutMs`      | 120000  | `McpClient.defaultRequestTimeoutMs`      | Each later `tools/call` exchange.                   |
| `queueCapacity`         | 64      | `McpClient.defaultQueueCapacity`         | Outbound frames waiting to be written.              |
| `maxFrameBytes`         | 1048576 | `McpClient.defaultMaxFrameBytes`         | One inbound JSON-RPC frame, in UTF-8 bytes.         |
| `maxOutboundFrameBytes` | 1048576 | `McpClient.defaultMaxOutboundFrameBytes` | One outbound JSON-RPC frame, in UTF-8 bytes.        |
| `maxTools`              | 256     | `McpClient.defaultMaxTools`              | Tools accepted across every catalog page.           |
| `maxToolNameBytes`      | 128     | `McpClient.defaultMaxToolNameBytes`      | UTF-8 bytes in one tool name.                       |
| `maxCatalogPages`       | 32      | `McpClient.defaultMaxCatalogPages`       | `tools/list` pages walked while following a cursor. |
| `maxStderrBytes`        | 2048    | `McpClient.defaultMaxStderrBytes`        | Child stderr retained as a diagnostic tail.         |

Every one must be a positive integer. A zero, a negative number, or a fraction
fails with `protocol_error` naming the option, before the process is spawned.

```ts
const client = yield * McpClient.connect({
  server: "large",
  command: "node",
  args: ["server.mjs"],
  maxTools: 512,
  maxFrameBytes: 4 * 1024 * 1024
})
```

## What each one is actually protecting

**The two frame sizes** protect memory. The stdout reader never retains more
than one bounded partial frame, so a server that writes a gigabyte without a
newline fails at the limit rather than growing the heap. The outbound bound
catches the mirror case: a tool argument large enough to be its own problem is
refused before it is written.

**`queueCapacity`** bounds outbound frames waiting on a server that has stopped
reading its stdin. Past capacity, an offer blocks until the deadline for that
request expires.

**`maxTools`, `maxToolNameBytes`, and `maxCatalogPages`** bound the catalog,
which is the part a model reads. A catalog past `maxTools` fails with
`invalid_response` rather than being truncated, because a silently truncated
toolset is worse than a refused connection. `maxCatalogPages` and a repeated
cursor both end a cursor walk that would otherwise never finish.

**`maxStderrBytes`** bounds a diagnostic buffer. Child stderr is drained
continuously and only the tail is retained, so a chatty server cannot fill
memory through the channel that exists to explain its failures.

**The two deadlines** are separate because they answer different questions. A
server that never completes a handshake is broken and should fail fast; a tool
that takes a minute may be working.

## The rules a tool name must satisfy

Beyond the byte length, a tool name may not contain:

- `/`, because the name is embedded in `mcp/<server>/<tool>`.
- A C0 control character (U+0000 through U+001F).
- U+007F.
- A C1 control character (U+0080 through U+009F).

A name that breaks any of these fails the connection with `invalid_response`.
The name reaches a model inside a flow name and the journal inside a declaration
digest, so a control character in it is not cosmetic.

Two tools with the same name in one catalog also fail: a duplicate would make
`mcp/<server>/<tool>` ambiguous.

## The rules a catalog entry must satisfy

- `tools` must be an array, and every element an object.
- `name` must be a non-empty string.
- `inputSchema` must be an object whose `type` is exactly `"object"`. A tool
  with no usable parameter document is refused rather than disclosed to a model
  as if it had one.
- `outputSchema`, when present, must be a JSON object.
- `nextCursor`, when present, must be a non-empty string, and must not repeat a
  cursor already seen.

## Persisting a configuration

`McpClient.ConnectOptionsSchema` is the authoritative decoder for a stored
server entry. It requires a non-empty `server` and `command`, string `args`, a
string-valued `env` record, and positive integers for every limit:

```ts
import * as McpClient from "@smthrs/mcp/McpClient"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)
const options = decode(JSON.parse(fileContents))
```

Use it wherever connection options arrive from a file or a database, so a bad
entry is a decode failure at the edge rather than a `protocol_error` at connect
time. See
[Configure servers for the CLI](/guides/configure-servers-for-the-cli/).

## Next

- [The life of a session](/concepts/the-session/): what the limits are
  protecting.
- [Troubleshooting](/troubleshooting/): the message each limit produces.

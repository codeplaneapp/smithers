---
title: "The life of a session"
description: "How an MCP session starts, what it holds, when it ends, and what happens to in-flight requests: the handshake, the catalog snapshot, scope-bound teardown, and cancellation."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/concepts/the-session.md"
---

An MCP session is a subprocess. Everything surprising about this package follows
from that: the process has to be started, negotiated with, bounded, and torn
down, and any of those steps can end the session in the middle of a call.

## Starting

`McpClient.connect` performs five steps before it returns, and a failure at any
of them fails the whole effect:

1. Spawn the command with `stdin`, `stdout`, and `stderr` piped. A spawn that
   fails is `spawn_failed`.
2. Send `initialize`, proposing `2025-06-18` and disclosing the frozen
   `McpClient.clientInfo` identity, `{ name: "smithers", version: "1.0.0-rc.0" }`.
3. Validate the result. The server's `protocolVersion` must be one of
   `McpClient.supportedProtocolVersions`, and its `capabilities` must declare a
   `tools` object. A server that serves no tools is refused with
   `protocol_error` rather than connected and left useless.
4. Send `notifications/initialized`. This is a notification, not a request: the
   server never replies, and the handshake is not complete until the client
   sends it.
5. Walk `tools/list`, following `nextCursor` until the server stops sending one.

Steps 2 through 5 are each bounded by `handshakeTimeoutMs`, which defaults to 10
seconds and is separate from the deadline later tool calls get.

## Holding

What the session holds is small: the server name, the tool catalog, and a way to
call one entry of it.

The catalog is a **snapshot**. It is fetched once and never refreshed. A server
that later announces `notifications/tools/list_changed` is not re-polled, and
server-initiated notifications are received and dropped. To pick up a changed
catalog, close the scope and connect again.

That choice is what makes the projection stable. `McpFlows` derives flow
declarations from the catalog, and a declaration digest that changed underneath a
running cell would be refused by the boundary that recorded it.

`callTool` checks the name against that snapshot before it writes anything: an
unknown tool fails with `tool_not_found` without a JSON-RPC frame reaching the
server.

## Ending

The connection is scoped, and the scope is the lifetime. Closing it tears the
process down. Four other events end a session, and all five are the same
terminal transition:

| Event                        | The error every waiter gets                    |
| ---------------------------- | ---------------------------------------------- |
| The scope closes.            | `connection_closed`, "connection scope closed" |
| The child exits.             | `connection_closed`, "exited with code N"      |
| Its stdout reaches EOF.      | `connection_closed`, "stdout closed"           |
| Its stdin closes.            | `connection_closed`, "stdin closed"            |
| A tagged reply is malformed. | `protocol_error`, naming what was malformed    |

Whichever arrives first wins. It closes the connection once, fails every pending
request with that one error, and rejects all later traffic with the same error,
so a caller never waits on a reply that can no longer come. A clean child exit
is still a closed session: Node reports an ordinary exit by ending stdout
successfully.

For `spawn_failed`, `timeout`, and `connection_closed`, the message carries a
bounded tail of the child's stderr, whitespace-collapsed, up to `maxStderrBytes`.
That is usually the only place a server says why it would not start.

## Noise and protocol traffic on stdout

MCP servers commonly log to stdout, so this client distinguishes noise from
protocol:

- A blank line, invalid JSON, a JSON scalar, an array, `null`, or a JSON object
  with no own `jsonrpc` property is **noise**, and is dropped.
- An object that does carry `jsonrpc` is **protocol traffic**. Its version must
  be exactly `"2.0"`; an envelope with an own `method` is a server notification
  and is dropped; anything else must be a valid reply with an id and exactly one
  of `result` or `error`.

A malformed tagged envelope closes the connection with `protocol_error`. A
well-formed reply for an id nobody is waiting on is dropped. The raw frame is
never attached to the error.

## Cancelling

Every MCP tool flow is declared `irreversible`, so an abandoned in-flight
mutation is a durability problem rather than a tidiness one. When a `tools/call`
times out or its fiber is interrupted, the client sends exactly one
`notifications/cancelled` for that request id.

The notification is best effort. A full outbound queue drops it rather than
delaying the deadline it reports, because a cancellation that made a timeout
late would defeat the timeout. `initialize` is never cancelled, and a request
that already received a reply, whether a result or a JSON-RPC error, is never
cancelled either.

## Next

- [Connect a server](/guides/connect-a-server/): the options that shape all
  of this.
- [Bound an untrusted server](/guides/bound-an-untrusted-server/): the nine
  limits and what each one protects.

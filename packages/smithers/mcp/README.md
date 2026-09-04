# @smthrs/mcp

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://mcp.smithers.sh

Model Context Protocol client and flow adapter for Smithers.

A remote MCP server's tools are not a second kind of capability the harness has
to know about. `@smthrs/harness/FlowBinding`'s own contract already names this
case: "a standard filesystem flow, a memory flow, an incoming MCP tool, a
durable child agent" are all just a flow declaration plus the code that runs it.
This package is the code that runs it: a stdio JSON-RPC client for the handshake
and `tools/list`/`tools/call`, and a projector that turns the resulting tool
catalog into one `FlowBinding.Binding` per tool.

```typescript
import { NodeServices } from "@effect/platform-node"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const source = yield* McpFlows.connected({
    server: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "..." }
  })
  return source
}))

await Effect.runPromise(Effect.provide(program, NodeServices.layer))
```

Each tool becomes a flow named `mcp/<server>/<tool>`. The connection's lifetime
is the scope's lifetime. The child inherits `PATH`, `HOME`, `USER`, `LANG`,
`LC_*`, `TERM`, `TMPDIR`, and `SHELL`; `env` explicitly adds or replaces names.
Other ambient variables, including provider credentials, are withheld.

Catalog tools must declare `inputSchema.type: "object"`. Structured-only tool
results are accepted with `content: []`, and declared `outputSchema` documents
are enforced for the supported keyword subset.

This is the client half of Smithers and MCP: a Smithers run calling somebody
else's tools. The other half, an agent such as Claude Code driving Smithers, is
the Smithers MCP server behind `smthrs mcp`.

## Documentation

The site at https://mcp.smithers.sh is built from `docs/` in this package:

- [`docs/README.md`](./docs/README.md) is the overview.
- [`docs/quickstart.md`](./docs/quickstart.md) connects to a real server and
  calls a tool.
- [`docs/api.md`](./docs/api.md) is the API reference: every public export of
  `McpClient`, `McpError`, and `McpFlows`.
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) lists every failure
  this package reports, with its cause and fix.

`docs/concepts/` explains the projection model and the life of a session;
`docs/guides/` covers connecting, filtering, authority, failures, structured
output, limits, CLI configuration, and testing.

Child stderr diagnostics in connection errors use `@smthrs/journal` credential
redaction and remain bounded by `maxStderrBytes` (2048 by default). Ordinary
startup diagnostics survive; credential-looking values are replaced with redaction
markers before messages reach a model.

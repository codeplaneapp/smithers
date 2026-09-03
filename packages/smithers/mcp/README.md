# @smthrs/mcp

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
is the scope's lifetime, and `env` is merged into the inherited child
environment rather than replacing it.

Catalog tools must declare `inputSchema.type: "object"`. Structured-only tool
results are accepted with `content: []`, and declared `outputSchema` documents
are enforced for the supported keyword subset described in the reference.

## Documentation

[`docs/reference.md`](./docs/reference.md) is the generated reference: the
declared authority every MCP flow carries, the nine bounds this client enforces
on an untrusted server, every `McpError` code and what it means, and the export
table for each public module. It is generated from this package's sources by
`node packages/smithers/mcp/scripts/docs.mjs`; see [`docs/README.md`](./docs/README.md)
for what owns which sentence.

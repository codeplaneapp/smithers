# @smthrs/mcp

This package declares `effect` as an exact
`4.0.0-rc.112` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://mcp.smithers.sh

Model Context Protocol client and flow adapter for Smithers.

`@smthrs/mcp` connects to an MCP server over stdio and projects the tools that
server offers as flows a Smithers agent can call. `McpClient` speaks the
protocol: the `initialize` handshake, `tools/list`, and `tools/call`.
`McpFlows` turns the resulting catalog into one `FlowBinding.Binding` per tool,
so a cell calls a remote tool with the same two lines it uses for a filesystem
flow, and nothing downstream needs to know the difference.

## Install

`@smthrs/mcp` is not published to npm yet. Its source is on
[GitHub](https://github.com/smithersai/smithers).

It needs Node.js 22.19+ (Node 22) or 24.11+, [`effect`](https://effect.website), and a
`ChildProcessSpawner`, which `@effect/platform-node` provides on Node. When it
publishes, the install is one command:

```bash
pnpm add @smthrs/mcp@next @effect/platform-node@4.0.0-rc.112
```

## Connect a server and read its flows

```typescript
import { NodeServices } from "@effect/platform-node"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const source = yield* McpFlows.connected({
    server: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    include: ["create_issue", "get_issue", "list_issues"]
  })
  const bindings = yield* source.bindings()
  return bindings.map((binding) => binding.descriptor.name)
}))

// [ "mcp/github/create_issue", "mcp/github/get_issue", "mcp/github/list_issues" ]
console.log(await Effect.runPromise(Effect.provide(program, NodeServices.layer)))
```

Each tool becomes a flow named `mcp/<server>/<tool>`. The connection's lifetime
is the scope's lifetime. The child inherits `PATH`, `HOME`, `USER`, `LANG`,
`LC_*`, `TERM`, `TMPDIR`, and `SHELL`; `env` explicitly adds or replaces names.
Other ambient variables, including provider credentials, are withheld.

Catalog tools must declare `inputSchema.type: "object"`. Structured-only tool
results are accepted with `content: []`, and declared `outputSchema` documents
are enforced for the supported keyword subset.

Session errors withhold raw child stderr, remote error text/data, and property
paths. An optional host-only [Diagnostics observer](https://mcp.smithers.sh/reference/api/#diagnostics)
provides bounded `Redacted` details for explicit local inspection. Successful
tool outputs, including `isError: true`, are returned unchanged.

Every projected flow declares the widest authority the capability vocabulary
can express, because an MCP tool is opaque code this package does not control.
Narrowing that declaration to what you actually grant a server is the host's
step, and the one thing standing between a projected source and a cell that can
call it.

This is the client half of Smithers and MCP: a Smithers run calling somebody
else's tools. The other half, an agent such as Claude Code driving Smithers, is
the Smithers MCP server behind `smthrs mcp`.

## Documentation

Full documentation is at [mcp.smithers.sh](https://mcp.smithers.sh):

- [Quickstart](https://mcp.smithers.sh/quickstart/): a real server in its own
  process, two tool calls, and the flows they project.
- [A remote tool as a flow](https://mcp.smithers.sh/concepts/tools-as-flows/):
  what the projection produces, and why nothing downstream knows the flow is
  remote.
- [Grant authority to MCP tools](https://mcp.smithers.sh/guides/grant-authority-to-mcp-tools/):
  the step between a projected source and a cell that can call it.
- [Configure servers for the CLI](https://mcp.smithers.sh/guides/configure-servers-for-the-cli/):
  the `--mcp-config` file the `smthrs` command line reads.
- [API reference](https://mcp.smithers.sh/reference/api/): every public export
  of `Diagnostics`, `McpClient`, `McpError`, and `McpFlows`.
- [Troubleshooting](https://mcp.smithers.sh/troubleshooting/): every failure
  this package reports, with its cause and fix.

## License

MIT. See [LICENSE](./LICENSE).

Trusted local diagnostics redact credentials and bound child stderr by `maxStderrBytes` (2048 by default). Model-facing connection errors withhold the child output.

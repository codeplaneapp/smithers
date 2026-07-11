# Agent adapters and account pools

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Connect agents

Smithers runs tasks through SDK agents, CLI harnesses, provider pools, accounts, capability registries, tool contracts, `image/audio/web-search/http` tools, and native session hijack where adapters support it.

## What you can do

Choose the best model or harness per step, mix providers in one workflow, and fail over when a configured worker is unavailable.

## Capabilities

### Provider pools

`planning/review/implement` pools with ordered failover in `.smithers/agents.ts`.

### Accounts

`smithers agent add` | `smithers agent list` | `smithers agent remove` manages per-account configDirs.

### SDK agents

AnthropicAgent, OpenAIAgent, HermesAgent, and Eliza-style agents run in-process through provider APIs and tools.

### CLI agents

ClaudeCodeAgent, CodexAgent, GeminiAgent, OpenCodeAgent, PiAgent, KimiAgent, AmpAgent, ForgeAgent, VibeAgent, OpenClaw, Antigravity, and Hermes CLI spawn vendor binaries.

### Capability registry

Adapters expose structured-output, tool, image, transcription, web-search, and surface capability metadata for routing and doctor reports.

### Account management

`smithers agent`s `add/list/remove/test` and usage commands manage local account config and quota visibility.

## Endpoints and commands

- `API <Task agent={...}>` ([docs](docs/integrations/cli-agents.mdx))
- `CLI smithers agents add` ([docs](docs/cli/overview.mdx))
- `CLI smithers agents doctor` ([docs](docs/cli/overview.mdx))
- `RPC listAccounts` ([docs](docs/rpc/list-accounts.mdx))

## Related docs

- [CLI agents](docs/integrations/cli-agents.mdx)
- [SDK agents](docs/integrations/sdk-agents.mdx)
- [Agent support](docs/agents/overview.mdx)

## Test cases

- `packages/agents/tests/agent-contract.test.js`
- `packages/agents/tests/sdk-agents.test.js`
- `packages/agents/tests/base-cli-agent-timeouts.test.js`
- `packages/agents/tests/cli-capabilities.test.js`
- `apps/cli/tests/agents-account-cli.e2e.test.js`
- `apps/cli/tests/cli-agent-detection.test.js`
- `apps/cli/tests/agents-ts-codegen.test.js`
- `apps/cli/tests/agent-next-steps.test.js`
- `apps/cli/tests/usage-command.e2e.test.js`
- `packages/engine/tests/cli-agent-event-output-capture.test.jsx`
- `packages/engine/tests/hijack-e2e.test.jsx`

## Observability

- Agent traces are collected into structured events and OTLP logs where supported.
- Usage and token reports expose `provider/account` consumption without printing credentials.

## Debugging

- Run `smithers agent`s doctor and `smithers agent`s capabilities to verify installed CLI harnesses and unsupported flags.
- Use `docs/concepts/execution-model.mdx` to decide whether an adapter runs in-process, as a child process, or behind a Sandbox boundary.

## Architecture

- `packages/agents/src/index.js` exports SDK and CLI agents, BaseCliAgent, capability reports, agent contracts, `HTTP/image/transcription/web-search` tools, and schema sanitizers.
- `apps/cli/src/agent-commands` owns account `add/list/remove/test` flows and generated agents.ts refresh.
- `docs/concepts/execution-model.mdx` documents in-process SDK vs subprocess CLI vs Sandbox execution.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `packages/agents/src`
- `apps/cli/src/agent-commands`
- `apps/cli/src/agent-detection.js`
- `docs/integrations/cli-agents.mdx`
- `docs/integrations/sdk-agents.mdx`

## Open gaps

- Kimi auth-setup errors should fail over to the next pool agent instead of failing the run.
- Many vendor CLI behaviors depend on locally installed binaries and `subscription/API-key` modes that cannot all be covered in clean CI.

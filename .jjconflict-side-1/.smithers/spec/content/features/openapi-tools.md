# OpenAPI tool generation

> **Status:** Fixed | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Integrate APIs

OpenAPI utilities load specs, list operations, build zod-backed tool schemas, create AI SDK-compatible tools, handle `auth/base` URLs, curate `names/descriptions`, and expose a CLI generator.

## What you can do

Turn an OpenAPI spec into agent-callable tools with typed inputs and real HTTP execution.

## Capabilities

### Tool factory

createOpenApiToolsSync and createOpenApiToolSync build executable tools from specs, operation filters, prefixes, and auth.

### Spec loading

`loadSpecSync/loadSpecEffect` handle objects, JSON strings, URLs, and relative server URL resolution.

### CLI generator

`smithers openapi list/generate` supports operation inventory and generated tool modules.

### Metrics

OpenAPI tool calls, errors, and duration are tracked for successful and failing executions.

## Endpoints and commands

- `API createOpenApiToolsSync` ([docs](docs/guides/openapi-tools-quickstart.mdx))
- `API listOperations` ([docs](docs/guides/openapi-tools-quickstart.mdx))
- `CLI smithers openapi generate` ([docs](docs/cli/overview.mdx))
- `CLI smithers openapi list` ([docs](docs/cli/overview.mdx))

## Related docs

- [OpenAPI concept](docs/concepts/openapi-tools.mdx)
- [OpenAPI LLM fragment](docs/llms-openapi.txt)

## Test cases

- `packages/openapi/tests/e2e.test.js`
- `packages/openapi/tests/tool-factory.test.js`
- `packages/openapi/tests/relative-server-url.test.js`
- `packages/openapi/tests/metrics.test.js`
- `apps/cli/tests/openapi-generate-command.test.js`

## Observability

- openApiToolCallsTotal, openApiToolCallErrorsTotal, and openApiToolDuration cover success and failure paths.
- Real HTTP round-trip tests verify generated tools execute against an actual local server rather than mocked responses.

## Debugging

- Use `smithers openapi list` to inspect operation IDs before generating tools.
- If a spec has relative servers, provide SPEC\_SOURCE\_URL or an explicit baseUrl; relative-server tests cover the error message.

## Architecture

- `packages/openapi/src/index.js` exports createOpenApiTools, createOpenApiTool, listOperations, spec loaders, schema builders, jsonSchemaToZod, and metrics.
- `apps/cli/src/index.js` registers openapi `list/generate` commands.
- `docs/guides/openapi-tools-quickstart.mdx` points to the opt-in llms-openapi fragment for full material.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 adversarial review: `bun test --timeout`=120000 --max-concurrency=1 `packages/openapi/tests/e2e.test.js` `packages/openapi/tests/tool-factory.test.js` `packages/openapi/tests/relative-server-url.test.js` `packages/openapi/tests/metrics.test.js` `apps/cli/tests/openapi-generate-command.test.js` passed with 34 tests, 0 failures.
- `packages/openapi/src`
- `apps/cli/src/index.js`
- `apps/cli/tests/openapi-generate-command.test.js`
- `docs/llms-openapi.txt`
- `packages/openapi`

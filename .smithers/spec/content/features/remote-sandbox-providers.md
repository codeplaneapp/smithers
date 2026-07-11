# Remote sandbox providers

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Isolate execution | **Tier:** Platform

Cloudflare, Vercel, AWS, GCP, and Daytona packages register provider-backed Sandbox runtimes that ship request bundles to remote `containers/jobs` and return result bundles with secret redaction.

## What you can do

Run full-OS workflow boundaries on managed infrastructure while keeping the Smithers workflow code portable across providers.

## Capabilities

### Provider kit

Shared sandbox provider contracts cover create, run, heartbeat, cleanup, `request/result` paths, and error normalization.

### Cloudflare Sandbox SDK

createCloudflareSandboxProvider runs Smithers sandbox requests through Cloudflare Sandbox SDK bindings.

### Vercel Sandbox

createVercelSandboxProvider supports `OIDC/access-token` auth, domains, duration caps, cleanup `keep/persist/destroy`, and secret scrubbing.

### AWS/GCP/Daytona providers

AWS `ECS/Fargate` or CodeBuild, GCP Cloud Run `Jobs/GCS`, and Daytona workspace providers use injected clients and mocks for deterministic tests.

## Endpoints and commands

- `API createCloudflareSandboxProvider` ([docs](docs/integrations/cloudflare.mdx))
- `API createVercelSandboxProvider` ([docs](docs/integrations/vercel-sandbox-provider.mdx))
- `API createAwsSandboxProvider` ([docs](docs/integrations/aws-sandbox-provider.mdx))
- `API createGcpSandboxProvider` ([docs](docs/integrations/gcp-sandbox-provider.mdx))
- `API createDaytonaSandboxProvider` ([docs](docs/integrations/daytona-sandbox-provider.mdx))

## Related docs

- [Cloudflare](docs/integrations/cloudflare.mdx)
- [AWS sandbox provider](docs/integrations/aws-sandbox-provider.mdx)
- [GCP sandbox provider](docs/integrations/gcp-sandbox-provider.mdx)
- [Vercel sandbox provider](docs/integrations/vercel-sandbox-provider.mdx)
- [Daytona sandbox provider](docs/integrations/daytona-sandbox-provider.mdx)

## Test cases

- `packages/cloudflare/tests/cloudflare-sandbox-provider.test.js`
- `packages/cloudflare/tests/cloudflare-sqlite.test.js`
- `packages/vercel/tests/createVercelSandboxProvider.test.js`
- `packages/aws/tests/createAwsSandboxProvider.test.js`
- `packages/gcp/tests/createGcpSandboxProvider.test.js`
- `packages/daytona/tests/createDaytonaSandboxProvider.test.js`
- `packages/aws/tests/awsSandboxProviderContract.test.js`
- `packages/gcp/tests/gcpSandboxProviderContract.test.js`
- `packages/daytona/tests/daytonaSandboxProviderContract.test.js`

## Observability

- Provider implementations surface remote ids and heartbeat metadata so `gateway/CLI` views can correlate a Smithers sandbox with provider resources.
- Sandbox metrics from `packages/sandbox` apply to remote providers as the runtime boundary.

## Debugging

- Use the provider mock environment tests before touching provider auth, cleanup, path mapping, result parsing, or secret redaction.
- For Cloudflare, read `docs/integrations/cloudflare.mdx` warning: Worker-native storage plus SDK agents works, but a Workers-native run driver for CLI workflows is not shipped.

## Architecture

- `packages/cloudflare`, `packages/vercel`, `packages/aws`, `packages/gcp`, and `packages/daytona` are separate optional provider packages re-exported by smithers-orchestrator subpaths.
- `packages/sandbox/src/provider-kit` supplies shared transport and provider contracts.
- Docs distinguish storage descriptors from remote execution providers, especially on Cloudflare.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `packages/cloudflare/src`
- `packages/vercel/src`
- `packages/aws/src`
- `packages/gcp/src`
- `packages/daytona/src`
- `packages/sandbox/src/provider-kit`

## Open gaps

- Provider tests use injected clients and mock environments; real cloud-account integration tests are not part of CI.
- Cloudflare package does not ship a turnkey Worker entry or Workers-native run driver for CLI-agent workflows.

# Hosted control-plane primitives

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Operate deployments | **Tier:** Platform

The control-plane package stores organizations, teams, projects, billing accounts, identity providers, usage events and limits, secret references, and audit events for hosted Smithers deployments.

## What you can do

Build hosted or multi-tenant Smithers services on durable `org/project/usage/audit` primitives without storing secret values in Smithers rows.

## Capabilities

### Tenant objects

Create orgs, teams, project grants, billing accounts, and identity providers in SQLite tables with foreign-key cascades.

### Usage and limits

Record usage, summarize usage, set quotas, and check `daily/weekly/monthly` rolling limit windows.

### Secret references

Store external secret-manager references and rotation metadata, not the secret values.

### Audit export

Record audit events and export org data, usage summaries, secret refs, and audit rows for review.

## Endpoints and commands

- `API ControlPlaneStore` ([docs](docs/deployment/control-plane.mdx))
- `API ensureControlPlaneTables` ([docs](docs/deployment/control-plane.mdx))
- `CLI smithers usage` ([docs](docs/cli/overview.mdx))

## Related docs

- [Control plane docs](docs/deployment/control-plane.mdx)
- [Production hardening](docs/deployment/production-hardening.mdx)

## Test cases

- `packages/control-plane/tests/control-plane.test.js`
- `apps/cli/tests/usage-command.e2e.test.js`
- `apps/cli/tests/token-store.test.js`

## Observability

- Usage events and audit events are durable rows intended for hosted export and `billing/reporting` layers.
- Token-store tests persist action-token use audits without printing bearer secrets.

## Debugging

- Use control-plane tests when changing ID validation, secret ref migration, quota checks, or audit export shape.
- For hosted services, layer SSO, billing provider, secret reads, object storage, and compliance controls outside the OSS package.

## Architecture

- `packages/control-plane/src/index.js` creates \_smithers\_cp\_\* tables and ControlPlaneStore methods.
- `docs/deployment/control-plane.mdx` states that the open-source package owns the durable data contract while hosted service layers own auth, payments, tenant isolation, and compliance operations.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `packages/control-plane/src/index.js`
- `packages/control-plane/tests/control-plane.test.js`
- `docs/deployment/control-plane.mdx`
- `apps/cli/src/token-store.js`
- `packages/control-plane`

## Open gaps

- This is a data-contract package, not a complete hosted control plane: SSO enforcement, billing checkout, tenant-isolated gateway deployment, object storage, and compliance operations live outside this repo.
- Usage command covers `account/provider` usage, not a full multi-tenant billing UI.

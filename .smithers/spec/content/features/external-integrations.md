# External event and messaging integrations

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Integrate APIs

Connect GitHub, Linear, and Telegram webhooks or polling sources to durable workflow signals with cursor storage, signature verification, normalized events, outbound actions, and Telegram approval components.

## What you can do

Start and steer durable workflows from real provider events while keeping cursors, signatures, retries, and message formatting in reusable adapters.

## Capabilities

### Provider-neutral sources

EventSource, PollingSource, CursorStore, verifySignature, and deliverEvents provide reusable ingestion contracts.

### GitHub and Linear

Typed clients, webhook sources, schemas, and workflow components cover inbound and outbound provider operations.

### Telegram workflows

OnMessage, SendMessage, and TelegramApproval connect bot updates and Mini App approval data to workflows.

### Telegram Bot API

The standalone package handles secret verification, update normalization, typed calls, retry hints, MarkdownV2, and message chunking.

## Endpoints and commands

- `API @smthrs/integrations/github` ([docs](docs/integrations/integrations.mdx))
- `API @smthrs/integrations/linear` ([docs](docs/integrations/integrations.mdx))
- `API @smthrs/integrations/telegram` ([docs](docs/integrations/telegram.mdx))
- `API smthrs/telegram` ([docs](docs/integrations/telegram.mdx))

## Related docs

- [Integration patterns](docs/integrations/integrations.mdx)
- [Telegram](docs/integrations/telegram.mdx)

## Test cases

- `packages/integrations/tests/github-webhook.test.js`
- `packages/integrations/tests/linear-pipeline.test.js`
- `packages/integrations/tests/telegram-pipeline.test.js`
- `packages/integrations/tests/pollingSource.test.js`
- `packages/integrations/tests/deliverEvents.test.js`
- `packages/telegram/tests/telegram.test.js`

## Observability

- IntegrationRuntime exposes source `start/stop` state, cursor progression, delivery failures, and interruption-safe shutdown through Effect services.
- Provider events are normalized to stable external event and signal names before delivery to workflows.

## Debugging

- Verify webhook secrets and normalized event ids before debugging downstream workflow signals.
- Inspect the cursor store when a polling source repeats or skips provider records.

## Architecture

- `packages/integrations` owns the provider-neutral event source, cursor, signature, delivery, GitHub, Linear, and Telegram workflow components.
- `packages/telegram` provides lower-level Bot API verification, normalization, retries, MarkdownV2, chunking, and deterministic test fakes.

## Fixes and diffs

- 2026-07-18 feature and docs audit: added the published integration and Telegram packages as a first-class feature; the full integrations package passed 264 tests.
- `packages/integrations`
- `packages/telegram`
- `docs/integrations/integrations.mdx`
- `docs/integrations/telegram.mdx`

## Open gaps

- Provider test suites use deterministic fixtures; live GitHub, Linear, and Telegram credential paths require deployment-specific smoke tests.

# Gateway and server

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Platform & delivery | **Tier:** Platform

HTTP/WS gateway (`packages/server,` `packages/gateway-client`) exposing runs, live events, PTY, approvals, and workflow launch to UIs and remote clients, including shared-DB run attribution and serverless resume/cron tick endpoints.

## What you can do

Watch and control runs from any UI or remote client over one API.

## Capabilities

### Live events

WebSocket run events power live UIs, including detached runs.

### Serverless tick

Resume/cron tick plus run-lease claims for serverless deployment.

## Test cases

- `pnpm -C packages/server test`

## Open gaps

- Serverless resume/cron tick and run-lease claims are new; add end-to-end proof beyond unit tests

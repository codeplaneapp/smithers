# Smithers UI (local)

The full local Smithers control surface — runs, approvals, timeline, logs, diff,
memory, scores, triggers, prompts, tickets, agents, and the workflow store — as a
single-page app that talks **only** to a local `smithers gateway` over RPC/WS.

No cloud. No auth, no jjhub/Plue, no Electric, no Cloudflare worker. Everything
streams from the gateway on `127.0.0.1:7331`. It is the local-only sibling of the
cloud `multi` app (which keeps all of that).

## Run it

```bash
# Build + serve the app against a local gateway (autostarts one if needed),
# then open it in your browser:
smithers ui --app

# Or in dev, against a running gateway:
SMITHERS_GATEWAY_PROXY_TARGET=http://127.0.0.1:7331 pnpm dev
```

`smithers ui --app` builds the bundle on first use, serves it from a small static
server that reverse-proxies the gateway (so the app is same-origin with it), and
opens the browser. Pass `--rebuild` to force a fresh build, `--app-port` to change
the serve port, `--gateway <url>` to point at a specific gateway.

## Shape

- `src/gateway/` — the gateway client (same-origin, no auth) + run inspector pieces.
- `src/sync/` — the live `GatewayCollections` registry the hooks read from.
- `src/app/` — the nav-sidebar shell, router, and URL→state mapping.
- `src/<surface>/` — one folder per surface (runs, approvals, memory, …).

Reusable, hook-driven widgets live in `@smthrs/gateway-ui` — use
those when building a custom workflow UI under `.smithers/ui/<workflow>.tsx`.

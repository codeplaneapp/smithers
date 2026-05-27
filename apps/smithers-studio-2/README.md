# Smithers Studio 2

Fresh UI shell for rebuilding Smithers Studio from the existing app as reference code.

## Scripts

- `npm run dev` from the repo root starts the Smithers Gateway and Studio 2 together.
- `pnpm --filter @smithers-orchestrator/smithers-studio-2 dev`
- `pnpm --filter @smithers-orchestrator/smithers-studio-2 typecheck`
- `pnpm --filter @smithers-orchestrator/smithers-studio-2 build`

The root dev script probes for available ports starting at `7331` for the Gateway and `5190` for the UI.
Override them with `SMITHERS_GATEWAY_PORT` and `SMITHERS_STUDIO_2_PORT`.

Terminal input is currently captured by the frontend Ghostty renderer. The real PTY/Ghostty backend should live in a separate service from the Gateway.

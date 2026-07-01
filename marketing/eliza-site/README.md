# marketing/eliza-site

Site for **Smithers × Eliza**: how Smithers gives an ElizaOS agent durable,
multi-step workflows it can actually finish. Single self-contained `index.html`,
dark-aurora style (mirrors `hermes-site`), deployed to Cloudflare via Alchemy at
**eliza.smithers.sh**.

Three tabs:

1. **Overview** — end-user / marketing landing page for the integration
   (Hermes-site style). The integration preview.
2. **Research** — the authoritative, fact-checked ElizaOS plugin reference
   (sourced from `@elizaos/core@1.7.2` types + official docs).
3. **Design** — the concrete `plugin-smithers` proposal: architecture, full code
   skeletons, packaging, test plan, phased rollout. Built on the existing
   `packages/pi-plugin` precedent.

The page is fully self-contained: `marked`, `highlight.js`, and both markdown
docs are inlined (no CDN, works offline).

## Regenerate `index.html`

The page is generated from the two markdown docs plus the inlined libraries. The
generator script lives in the scratchpad used to author it; to rebuild from
sources, re-run that `build-site.cjs`. The committed `index.html` is the source
of truth for the deploy — `build.mjs` just stages it into `dist/`.

## Preview locally

```bash
npm install            # one-time (alchemy, for deploy)
npm run build          # stages dist/index.html
npx serve dist         # or open index.html directly
```

## Deploy

```bash
npm run deploy         # binds eliza.smithers.sh
npm run destroy        # teardown
```

Run with `node` (bun segfaults on the Alchemy entrypoint). Required env:
`CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID` if the token spans multiple
accounts) and `ALCHEMY_PASSWORD` for the encrypted state. The `smithers.sh` zone
must live in that Cloudflare account. `node_modules/`, `dist/`, and `.alchemy/`
(local encrypted deploy state) are gitignored.

## Links

- Smithers: https://github.com/smithersai/smithers
- ElizaOS: https://github.com/elizaOS/eliza

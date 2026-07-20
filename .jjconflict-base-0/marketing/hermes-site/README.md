# marketing/hermes-site

Marketing site for **Smithers × Hermes**: how Smithers makes a Hermes agent's
skills faster, cheaper, and more reliable, and lets it take on bigger multi-step
jobs and actually finish them.

The copy is written in plain language for the Hermes audience (everyday people
running an agent in Telegram / Discord / Slack), not for technical or IDE/CI
readers. No jargon ("durable", "VPS", "checkpoints"). The site is Hermes-only;
the Eliza integration lives in the docs, not here.

Single self-contained `index.html` (no external assets), dark-aurora style.
Deployed to Cloudflare via Alchemy at **hermes.smithers.sh**.

## Preview locally

```bash
npm install            # one-time (alchemy, for deploy)
npm run build          # stages dist/index.html
npx serve dist         # or open index.html directly
```

## Deploy

```bash
npm run deploy         # binds hermes.smithers.sh
npm run destroy        # teardown
```

Run with `node` (bun segfaults on the Alchemy entrypoint). Required env:
`CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID` if the token spans multiple
accounts) and `ALCHEMY_PASSWORD` for the encrypted state. The `smithers.sh` zone
must live in that Cloudflare account. `node_modules/`, `dist/`, and `.alchemy/`
(local encrypted deploy state) are gitignored.

## Links

- Hermes: https://github.com/NousResearch/hermes-agent
- Smithers: https://github.com/smithersai/smithers
- Integration docs: https://smithers.sh/integrations/hermes

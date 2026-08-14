# storybook-site

Storybook catalog for `@smthrs/ui`, deployed at
https://storybook.smithers.sh as a Cloudflare Worker serving the static
Storybook build (same worker pattern as the other `apps/*-site` workers).

```sh
pnpm dev              # storybook dev server on :6006
pnpm build            # static build into site/ (gitignored)
pnpm run deploy       # build + wrangler deploy to storybook.smithers.sh
```

Stories live in `stories/*.stories.tsx` and import only from
`@smthrs/ui`. The preview decorator renders
`<SmithersUiStyles withTheme />` and stamps `data-theme` on the iframe root,
so every story can be flipped between light and dark from the toolbar.

The catalog is curated per family (primitives, chat, agentic, approvals,
artifacts, diff); it does not aim to enumerate every export. Gateway-bound
widgets (`smthrs/gateway-ui`) are out of scope here because
they fetch live run data; see the styleguide served by the Gateway for those.

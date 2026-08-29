# React + Tailwind + Vite Electrobun Template

A fast Electrobun desktop app template with React, Tailwind CSS, and Vite for hot module replacement (HMR).

## Getting Started

```bash
# Install dependencies (pnpm workspace install, from the monorepo root)
pnpm install

# Development without HMR (uses bundled assets)
bun run dev

# Development with HMR (recommended)
bun run dev:hmr

# Build for production
bun run build

# Build for production release
bun run build:prod
```

## How HMR Works

When you run `bun run dev:hmr`:

1. **Vite dev server** starts on `http://localhost:5173` with HMR enabled
2. **Electrobun** starts and detects the running Vite server
3. The app loads from the Vite dev server instead of bundled assets
4. Changes to React components update instantly without full page reload

When you run `bun run dev` (without HMR):

1. Electrobun starts and loads from `views://mainview/index.html`
2. You need to rebuild (`bun run build`) to see changes

## Project Structure

This package (`smithers-ui`) is one of three apps in the monorepo. Code it used
to own now lives in siblings: `apps/shared` publishes the wire contracts as the
workspace package `smithers-shared`, and `apps/server` holds the Cloudflare
Worker. Runtime packages come from the monorepo's `packages/` tree as pnpm
workspace links; there is no vendored `@smthrs` closure any more.

```
apps/
├── shared/                 # smithers-shared: wire contracts (imported as "smithers-shared/<Module>")
├── server/                 # Cloudflare Worker + wrangler.jsonc
└── ui/                     # this package
    ├── src/
    │   ├── bun/            # Electrobun main process (index.ts, CloudAgent, LocalRepository)
    │   ├── dev/            # AgentApi middleware for the vite dev/preview server
    │   └── mainview/       # React renderer (App.tsx, main.tsx, index.html, index.css)
    ├── scripts/            # e2e and live-check drivers
    ├── electrobun.config.ts
    ├── vite.config.ts
    ├── tailwind.config.js
    └── package.json
```

## Customizing

- **React components**: Edit files in `src/mainview/`
- **Shared contracts**: Edit `apps/shared/src/`, import as `smithers-shared/<Module>`
- **Dev-server API**: Edit `src/dev/AgentApi.ts`
- **Tailwind theme**: Edit `tailwind.config.js`
- **Vite settings**: Edit `vite.config.ts`
- **Window settings**: Edit `src/bun/index.ts`
- **App metadata**: Edit `electrobun.config.ts`

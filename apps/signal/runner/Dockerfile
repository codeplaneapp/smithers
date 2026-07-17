# The Smithers Signal — daily-ceo-intel runner.
#
# Bun container running the Smithers control plane headless (docs/deployment/serverless.mdx
# "Bun container" recipe), Cloudflare as the container platform. Bakes in this repo's
# `.smithers` workflow pack and its dependencies so a scheduled run needs only env vars.
FROM oven/bun:1.3 AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY .smithers ./.smithers
COPY config ./config
RUN bun install --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "run", "apps/signal/runner/src/entry.ts", "--serve"]

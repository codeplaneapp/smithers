# The cache service. Bun ships a Postgres client, so the image has no
# dependency tree and no install step.
ARG BUN_IMAGE=oven/bun@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
FROM ${BUN_IMAGE}

WORKDIR /srv
COPY config.js protocol.js storage.js server.js ./

ENV PORT=8080
EXPOSE 8080
USER bun

CMD ["bun", "run", "server.js"]

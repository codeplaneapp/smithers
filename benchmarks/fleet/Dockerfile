# Rollout container for the benchmark fleet.
#
# One container runs one Claude subscription's shard. Auth is injected at launch
# with `-e CLAUDE_CODE_OAUTH_TOKEN=<token>` (from `claude setup-token`) and NO
# ANTHROPIC_* vars, so ClaudeCodeAgent uses the subscription. Scoring is NOT done
# here — hidden-test grading runs on the separate amd64 Docker pool.
#
# Build (from repo root):
#   docker build -f benchmarks/fleet/Dockerfile -t smithers-fleet-rollout .
# Run one shard:
#   docker run --rm \
#     -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN_1" \
#     -e FLEET_SHARD_FILE=/shard/shard.json \
#     -e SMITHERS_BACKEND=postgres -e SMITHERS_POSTGRES_URL="$PG_URL" \
#     -v "$PWD/shard-1.json:/shard/shard.json:ro" \
#     smithers-fleet-rollout
FROM oven/bun:1.3

RUN apt-get update \
  && apt-get install -y git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI (the agent the rollout drives). Pin/replace with your
# preferred install channel; the fleet only needs `claude` on PATH.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY .smithers ./.smithers
COPY benchmarks/fleet ./benchmarks/fleet
RUN bun install --frozen-lockfile

# No ANTHROPIC_* here — subscription auth (CLAUDE_CODE_OAUTH_TOKEN) must win.
ENV SMITHERS_ROLE=fleet-rollout
# `bun <file>.ts` does not add node_modules/.bin to PATH, so point the worker at
# the workspace-installed smithers bin explicitly.
ENV FLEET_SMITHERS=/app/node_modules/.bin/smithers
CMD ["bun", "benchmarks/fleet/worker.ts"]

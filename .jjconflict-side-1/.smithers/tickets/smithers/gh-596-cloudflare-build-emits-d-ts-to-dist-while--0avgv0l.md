# 🐛 cloudflare: build emits d.ts to dist/ while the package ships committed src/index.d.ts — published types can silently go stale

GitHub: https://github.com/smithersai/smithers/issues/596

**What happens**
packages/cloudflare/tsup.config.ts:3-9 sets `entry: ["src/index.js"], dts: true, clean: true` with no `outDir`, so `pnpm -C packages/cloudflare build` (`tsup --dts-only`, package.json:18) writes `dist/index.d.ts`. But package.json exports `types: "./src/index.d.ts"` (a committed file) and `files: ["src/"]` — dist/ is never published.

**Why it's wrong / failure scenario**
The build never refreshes the shipped type surface: after a source change to src/index.js, the regenerated declarations land in dist/ and the committed src/index.d.ts silently drifts. Consumers get stale types for `@smithers-orchestrator/cloudflare`. Sibling packages avoid this — packages/protocol and packages/tool-context tsup configs use `outDir: "src"`, `dts: { only: true }`, `clean: false`.

**Expected behavior**
Match the sibling pattern (`outDir: "src"`, `dts: { only: true }`, `clean: false`) so the build refreshes the committed src/index.d.ts, or add a copy step — plus ideally a CI freshness check.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).

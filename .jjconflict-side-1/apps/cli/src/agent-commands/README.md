# agent-commands

The two halves of `smithers agents add`, plus the registry-driven regeneration
of a project's generated agents file.

- `agentAddWizard.js` — interactive @clack/prompts flow; loops until the user
  is done adding accounts and returns the labels added this session.
- `runAgentAdd.js` — non-interactive core: registers an account via
  `@smithers-orchestrator/accounts`, verifies subscription config dirs, and
  returns `{ ok, account | reason, regen }`. Also exports `pingAccount`, a
  best-effort `<bin> --version` health probe the wizard runs after adding.
- `regenerateAgentsTsIfPresent.js` — rewrites `.smithers/agents.ts` after a
  registry change so the workspace agents file tracks the registry.

How they fit: the wizard collects provider/label/credentials and delegates to
`runAgentAdd` with `skipLogin: true` (the user confirmed login themselves);
`runAgentAdd` calls `regenerateAgentsTsIfPresent` on success.

Entry points: `index.js` imports all three for the `agents` command family;
`init-command.js` runs the wizard during interactive init.

Gotchas:

- The provider → bin/env-var tables exist in BOTH files with different shapes
  (the wizard's variant omits the `null` api-key entries and carries
  per-provider login recipes/postInstructions), so their membership checks use
  different sentinels (`!== undefined` vs `!== null`) — do not merge them
  casually.
- `agents.ts` is only rewritten while it still starts with the
  `// smithers-source: generated` sentinel; hand-edited files are never
  overwritten.

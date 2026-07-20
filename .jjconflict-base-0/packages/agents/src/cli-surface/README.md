# cli-surface/

`CLI_AGENT_SURFACE_MANIFEST` (`cliAgentSurfaceManifest.js`) — a hand-maintained
compatibility contract listing, per CLI agent: the flags Smithers emits, known
unsupported flags with their replacements, option-to-flag/env mappings, and the
resume contract. `index.js` adds the lookup helpers
(`getCliAgentSurfaceManifestEntry`, `listCliAgentSurfaceManifests`);
`CliAgentSurfaceTypes.ts` is the type sidecar.

Scope: only the command surface Smithers emits directly. User-supplied
`extraArgs` are deliberately not modeled.

Consumers: the cli-capabilities doctor cross-checks `emittedFlags` against
`unsupportedFlags` and binary names; `AntigravityAgent` reads its own entry.

Gotcha: keep entries in sync with the corresponding `*Agent.js` adapters — the
doctor only catches drift that is expressible in the manifest.

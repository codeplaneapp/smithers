# capability-registry/

The `AgentCapabilityRegistry` shape — each adapter's declaration of its engine,
runtime tools, MCP bootstrap mode, skills support, human-interaction methods,
and built-in capabilities — plus the normalization/fingerprint pipeline over it.

Pipeline:

1. `normalizeCapabilityStringList.js` — dedupe/sort/trim a string list.
2. `normalizeCapabilityRegistry.js` — produce the canonical (sorted, deduped)
   registry form.
3. `hashCapabilityRegistry.js` — sha256 fingerprint over a stable JSON encoding
   (keys sorted recursively, `undefined` entries dropped).

Type sidecars: `AgentCapabilityRegistry.ts`, `AgentToolDescriptor.ts`.

Consumers: each CLI adapter's `create*CapabilityRegistry` factory (`src/*.js`),
the cli-capabilities report/doctor, and `packages/engine` (which records the
fingerprint per run). Exported via the package's `./capability-registry` entry
(`index.js`).

Gotcha: fingerprints must be stable — any change to normalization or key
ordering changes every registry hash.

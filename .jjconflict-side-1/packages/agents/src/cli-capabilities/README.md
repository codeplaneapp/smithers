# cli-capabilities/

Capability report and doctor for the built-in CLI agents.

- `getCliAgentCapabilityReport.js` — pairs each adapter in
  `CLI_AGENT_CAPABILITY_ADAPTERS` with its capability-registry factory and its
  cli-surface manifest entry, and fingerprints the registry via
  `hashCapabilityRegistry`.
- `getCliAgentCapabilityDoctorReport.js` — validates registry invariants and
  registry/surface consistency, emitting per-agent issues with `error` or
  `warning` severity.
- `formatCliAgentCapabilityDoctorReport.js` — plain-text rendering of the
  doctor report.
- Type sidecars: `CliAgentCapabilityAdapterId.ts`,
  `CliAgentCapabilityReportEntry.ts`, `CliAgentCapabilityDoctorReport.ts`.

Entry points: the package's `./cli-capabilities` export (`index.js`), which
also re-exports the cli-surface manifest getters.

Gotchas:

- Adding a new CLI agent means updating `CLI_AGENT_CAPABILITY_ADAPTERS` here,
  the `CliAgentCapabilityAdapterId` union, AND the cli-surface manifest — the
  report throws at build time if a manifest entry is missing.
- Doctor `ok` is false on warnings too (`issueCount` counts both severities).

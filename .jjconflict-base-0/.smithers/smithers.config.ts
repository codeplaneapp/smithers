export const repoCommands = {
  lint: null,
  test: null,
  coverage: null,
} as const;

// This repo's run history (698 runs) lives in the legacy SQLite store; this
// CLI version otherwise defaults to PGlite and the read commands refuse until
// you migrate. Pin SQLite so ps/inspect/approve see existing + new runs.
// (Operational; remove after `smithers migrate`.)
export default { repoCommands, backend: "sqlite" as const };

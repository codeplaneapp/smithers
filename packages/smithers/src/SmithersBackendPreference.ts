/**
 * The backend a workspace selects and the precedence level that chose it,
 * resolved without booting or probing any store.
 */
export type SmithersBackendPreference = {
  backend: "sqlite" | "pglite" | "postgres";
  source: "options" | "env" | "config" | "marker" | "default";
  workspaceRoot: string;
  /** Set when `options.backend` supplied the answer. */
  explicitBackend?: "sqlite" | "pglite" | "postgres";
  /** Set when `SMITHERS_BACKEND` supplied the answer. */
  envBackend?: "sqlite" | "pglite" | "postgres";
  /** Set when `.smithers/smithers.config.ts` supplied the answer. */
  configBackend?: "sqlite" | "pglite" | "postgres";
  migratedMarker: { exists: boolean; backend?: "sqlite" | "pglite" | "postgres" };
};

/**
 * A resolved VCS executable plus where Smithers found it.
 *
 * - `env`: an explicit override (e.g. `SMITHERS_JJ_PATH`)
 * - `bundled`: a binary shipped inside a `@smithers-orchestrator/jj-<platform>` package
 * - `path`: the bare command name, left for the OS to resolve against `PATH`
 */
export type ResolvedBinary = {
	path: string;
	source: "env" | "bundled" | "path";
};

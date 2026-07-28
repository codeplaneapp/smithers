/**
 * How a stale run can be relaunched.
 *
 * - `workflow-file` — the ordinary case: the run was started from a `.tsx`
 *   file, so `smithers up <file> --resume` re-enters it.
 * - `builtin` — the run was started by a BUILT-IN workflow (`smithers
 *   oneshot`), which has no file on disk. Such a run durably records the argv
 *   that recreates it, so it can be resumed by re-running that command.
 */
export type ResumeTarget =
  | { kind: "workflow-file"; workflowPath: string; cwd: string }
  | { kind: "builtin"; command: string; args: readonly string[]; cwd: string };

/**
 * The `builtinResume` descriptor persisted in a built-in run's `config_json`.
 * `args` excludes the run-identity flags (`--run-id`, `--resume`), which the
 * resume path appends, so one descriptor stays correct across every resume.
 */
export type BuiltinResumeDescriptor = {
  /** Top-level CLI subcommand, e.g. `"oneshot"`. */
  command: string;
  args: string[];
  /** Directory the resumed process must run in. */
  cwd: string;
};

export type WorkspaceInfo = {
  name: string;
  /** Not currently populated by `workspaceList` — always `null`. */
  path: string | null;
  /** Whether this is the current workspace. Populated on modern jj via the
   * `current_working_copy` template keyword; also correct on the legacy
   * human-output fallback (`*` marker parsing). */
  selected: boolean;
};

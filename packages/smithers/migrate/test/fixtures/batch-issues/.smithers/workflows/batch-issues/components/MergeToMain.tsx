import { Task, outputs } from "../smithers";
import { codex } from "../agents";
import type { LinearIssue } from "../schemas/issue";

interface MergeToMainProps {
  issue: LinearIssue;
}

export function MergeToMain({ issue }: MergeToMainProps) {
  const id = issue.identifier;

  return (
    <Task
      id={`${id}:merge`}
      output={outputs.merge}
      agent={codex}
      timeoutMs={10 * 60 * 1000}
    >
      {`Merge the changes for issue ${id} from worktree at /tmp/smithers-batch/${id} into main using jj.

Steps:
1. Navigate to the worktree at /tmp/smithers-batch/${id}
2. Use jj to identify the changes made in this worktree
3. Squash the changes into main: jj squash
4. Verify no conflicts
5. If conflicts exist, attempt to resolve them
6. Report success/failure

IMPORTANT: Use jj commands only, never git.

Report the change ID that was squashed.`}
    </Task>
  );
}

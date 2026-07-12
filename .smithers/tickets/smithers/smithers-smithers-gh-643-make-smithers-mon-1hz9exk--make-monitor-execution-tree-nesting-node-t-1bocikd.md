# Make monitor execution-tree nesting, node types, statuses, and failure rollups legible

GitHub: https://github.com/smithersai/smithers/issues/1126

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-execution-tree-retries-nesting-time-0quyuma.md

Context: Operators need to scan nested workflow, sequence, parallel, loop, and task execution state quickly. Acceptance criteria: render clear container nesting and node-type markers; distinguish running, waiting, success, failure, cancelled, and queued states; show iterations and relevant attempt/retry metadata; auto-expand paths requiring attention; show a failure marker or count on collapsed ancestors; preserve honest empty and loading states.

# Review commands

Comment `@smithers review` on an open pull request to trigger the action.
The commenter must be an owner, member, or collaborator.

For a local walkthrough without model calls:

```sh
smithers-review /path/to/repo --no-review --no-narrate --quiz off
```

`--no-review` skips review agents. `--no-narrate` uses deterministic story order.
`--quiz` is independent of both flags and defaults to `auto`, which calls a
model for high or critical impact changes. Set `--quiz off` alongside both
flags for offline use. `--quiz on` forces quiz generation.

`--timeout <min>` sets a deadline for each file review, verification, narration,
and quiz action. The default is 10 minutes; values must be finite and at least
1 minute. Each action gets its own deadline, including model retries and schema
corrections. Expiry interrupts the call. A timed-out file becomes a
`subtask_error` warning; verification leaves findings unverified, narration uses
the deterministic story, and quiz generation returns no quiz.

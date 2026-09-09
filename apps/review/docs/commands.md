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

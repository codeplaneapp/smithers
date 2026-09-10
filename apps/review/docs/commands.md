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

The terminal and JSON run summary include each review warning. A failed
verification promotes an otherwise successful review to
`completed_with_warnings`, retains its findings, and identifies the verifier
seat and failure reason. The findings remain unverified.

The standalone HTML includes review status, warnings, and per-file coverage.
Failed, skipped, and partial reviews do not present zero findings as a clean
result. Files excluded from review or carrying file-review errors are marked
`not reviewed`; a file with errors may have been only partially reviewed.

`--out` (default `.smithers-review/walkthrough.html`) is replaced atomically.
Each render also retains an independent HTML file in `.smithers-review-artifacts/`
beside the output. The workflow returns that file as `walkthrough.artifactPath`;
`--publish` uploads it, so concurrent runs cannot swap published content.
The JSON summary exposes it as `walkthroughArtifactPath`. Retain these files
while a run may resume or publish; remove them manually when no longer needed.
Older recorded results without an artifact path must be rerun before publishing.

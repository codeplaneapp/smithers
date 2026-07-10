# [low] Diagnostics can report secondary Codex auth failures after aborts

GitHub: https://github.com/smithersai/smithers/issues/632

Observed after a Codex task was aborted.

Primary event:

```text
warn child process interrupted process:codex=0ms timeoutMs=1800000 reason='CLI aborted'
...
error="CLI aborted See https://smithers.sh/reference/errors"
```

Follow-up diagnostic:

```text
warn [diagnostics] codex: api_key_valid=fail: Codex CLI auth.json API key is invalid (401 Unauthorized) (188ms)
```

Later Codex invocations worked in the same environment, so the auth diagnostic looked secondary to the abort rather than the root cause.

Expected: diagnostics should distinguish the primary failure from follow-up probe failures, especially when a probe result may not explain the task failure.


---
name: smithers-oneshot
description: Run one well-scoped goal with a strong agent in the background, with optional review and a live UI. Run `smithers oneshot --help` for usage details.
requires_bin: smithers
command: smithers oneshot
---

# smithers oneshot

Run one well-scoped goal with a strong agent in the background, with optional review and a live UI. The kimi seat runs Kimi K3; review runs on Sol at high effort.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `goal` | `string` | no | Goal to complete; required unless using --status or a preference setter |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--goal-file` | `string` |  | Read a long goal from a file |
| `--model` | `string` | `auto` | Model slot (sol, terra, luna, kimi, fable, opus, sonnet) or canonical model id |
| `--agent` | `enum` |  | `codex\|kimi\|claude-code\|opencode` |
| `--review` | `enum` | `stored` | Review preference for this run (`on\|off`) |
| `--set-review` | `enum` |  | Persist the review preference (`on\|off`) |
| `--set-trivial` | `enum` |  | Persist trivial-task routing (`direct\|oneshot`) |
| `--status` | `boolean` | `false` | Print usable agents, model chain, and stored preferences as JSON |
| `--cwd` | `string` | `.` | Working directory for the task |
| `--detach` | `boolean` | `true` | Run in the background; `--detach false` runs in the foreground |
| `--interactive` | `boolean` | `false` | Open the full-screen TUI monitor |

## Notes

- Oneshot handles any clear single-goal ask, small or repo-wide: one strong agent finishes goals of up to roughly 300k tokens in a single run. Do not author a workflow just because the goal is large; workflows are for approval gates, staged phases, parallel lanes, or reuse.
- Run `--status` before first use; when no usable agent is detected, use the direct or workflow route instead.
- Overrides: "oneshot" forces oneshot, "oneshot with review" adds `--review on`, "oneshot without review" adds `--review off`.
- A workspace can override the built-in workflow with `.smithers/workflows/oneshot.tsx` and its dashboard with `.smithers/ui/oneshot.tsx`.
- See the [oneshot guide](https://smithers.sh/guides/oneshot) for routing tiers and the live status narrator.

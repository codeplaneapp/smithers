# Agent role launch arguments

`roleLaunchArgv` composes the harness executable, model option, and validated model id. Invalid model ids throw an `Error` before launch.

Delegated tasks are trimmed. A nonempty task is passed as one prompt argument after the `--` option terminator. A task whose first non-whitespace character is `-` throws an `Error` before launch.

Claude and Codex receive the prompt directly. OpenCode receives it through `opencode run -m <model> -- <task>`. An absent or whitespace-only task keeps the interactive launch arguments without a prompt or terminator.

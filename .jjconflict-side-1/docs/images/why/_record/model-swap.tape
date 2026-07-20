# Records docs/images/why/model-swap.gif
# Prereq: `brew install vhs` (https://github.com/charmbracelet/vhs)
# Run from repo root: vhs docs/images/why/_record/model-swap.tape
#
# Goal: prove "any model, any harness" by running the SAME workflow against
# different agents back to back, showing the diff is one line.
#
# TODO before recording: point this at a real example workflow that selects its
# agent from input (or edits one `agent={...}` line). The exact swap mechanism
# depends on which example you use — wire it to your preferred one. The shape
# below assumes a workflow that reads `--input '{"agent":"..."}'`.

Output docs/images/why/model-swap.gif

Set Shell "bash"
Set FontSize 16
Set Width 1180
Set Height 640
Set Theme "Catppuccin Mocha"
Set Padding 18

Type "# same workflow.tsx, three different harnesses, zero diff" Enter
Sleep 1s

Type "bunx smithers-orchestrator up workflow.tsx --input '{\"agent\":\"claude\"}'"  Sleep 300ms Enter
Sleep 4s

Type "bunx smithers-orchestrator up workflow.tsx --input '{\"agent\":\"codex\"}'"  Sleep 300ms Enter
Sleep 4s

Type "bunx smithers-orchestrator up workflow.tsx --input '{\"agent\":\"kimi\"}'"  Sleep 300ms Enter
Sleep 4s
Sleep 1s

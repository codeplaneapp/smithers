# Records docs/images/why/crash-resume.gif
# Prereq: `brew install vhs` (https://github.com/charmbracelet/vhs)
# Run from repo root: vhs docs/images/why/_record/crash-resume.tape
#
# Mirrors the live durability demo in .smithers/workflows/demo.tsx:
# kill the process while `plan` is in flight, then resume from the last frame.

Output "docs/images/why/crash-resume.gif"

Set Shell "bash"
Set FontSize 16
Set Width 1180
Set Height 640
Set Theme "Catppuccin Mocha"
Set Padding 18

Hide
Type "cd .smithers/workflows/demo-stage && rm -f smithers.db*" Enter
Sleep 600ms
Show

Type "bunx smithers-orchestrator up sample.tsx --run-id r1"  Sleep 400ms  Enter
Sleep 3500ms
# laptop closes mid-run
Ctrl+C
Sleep 1200ms
Type "bunx smithers-orchestrator cancel r1 || true"  Enter
Sleep 900ms

Type "bunx smithers-orchestrator up sample.tsx --run-id r1 --resume true --force"  Sleep 400ms  Enter
# research skipped · plan -> attempt 2 · implement runs fresh
Sleep 6500ms
Sleep 2s

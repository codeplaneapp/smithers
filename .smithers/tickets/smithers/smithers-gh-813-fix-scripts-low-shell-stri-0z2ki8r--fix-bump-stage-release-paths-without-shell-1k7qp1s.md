# 🔒 fix(bump): stage release paths without shell interpolation

GitHub: https://github.com/smithersai/smithers/issues/1032

Parent: smithers/gh-813-fix-scripts-low-shell-string-interpolation-1f1b5aw.md

Context: scripts/bump.mjs constructs a manually quoted git add command from workspace-derived paths and release artifact patterns. Acceptance criteria: invoke git with an argument array and a -- separator; expand or otherwise preserve the intended release artifact selection without shell evaluation; add tests using a fake git executable to capture argv for paths containing spaces, quotes, semicolons, backticks, and dollar syntax; preserve staging of all files required by the version bump.

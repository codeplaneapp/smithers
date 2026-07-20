# 🐛 fix(smithers/tools): [low] grep passes pattern to rg without `--`, dash-leading patterns silently fail

GitHub: https://github.com/smithersai/smithers/issues/695

_via ultracode (Opus multi-agent) review_

**Summary:** `grepTool` places the user-controlled `pattern` directly in rg's argv with no `--` end-of-options separator, so any pattern beginning with `-` is parsed by rg as flags instead of a search term.

**Location:** `packages/smithers/src/tools/grep.js:13`
```js
const result = await captureProcess("rg", ["-n", pattern, resolvedRoot], {…});
```
`captureProcess` (`packages/smithers/src/tools/utils.js:96,123`) uses `spawn(command, args, …)` — an argv array, no shell — so `pattern` reaches rg's argument vector verbatim.

**Failure scenario:**
- `grepTool("-world", path)` runs `rg -n -world <path>`; rg treats `-world` as combined short flags rather than a pattern → wrong/empty output, so the tool reports "no matches" for a string that is present. Verified: `rg -n -- -world f.txt` matches (exit 0); `rg -n -world f.txt` does not.
- The pattern slot also accepts arbitrary rg flags (e.g. `-i`, `--pre`, `-f/--file`, `--search-zip`), letting a pattern value change search behavior or reach dangerous options — a defense-in-depth hole for a tool meant to run under sandbox restrictions.

**Why it matters:** Any agent/workflow searching for a token that starts with `-` (regex alternations, CLI flag literals, negative classes like `-\d`) gets silently wrong results from a core built-in tool.

**Fix:** Insert `"--"` before the pattern — `["-n", "--", pattern, resolvedRoot]` — or use `-e pattern`.

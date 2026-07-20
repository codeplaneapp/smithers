# 🐛 tui: hijack Returned dialog height 6 clips its "[d] dismiss" line

GitHub: https://github.com/smithersai/smithers/issues/583

**What happens**
`packages/tui/src/modes/HijackMode.tsx:155-167` — the Returned-from-hijack dialog is a `border={true}` box with `height={6}` containing five one-line `<text>` children (title, `hijackExitMessage`, `resumedNote`, blank spacer, `[d] dismiss`). The border consumes the top and bottom rows, leaving 4 inner rows for 5 lines.

**Why it's wrong / failure scenario**
The clipped line is `[d] dismiss` — the only advertised control. The `d`/Esc/Enter handlers still work, but after returning from a hijack the user sees a dialog with no visible way to dismiss it.

**Expected behavior**
`height={7}` (2 border + 5 content), or compute height from the row count the way ApprovalBanner/HumanRequestBanner in TreeMode.tsx do.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).

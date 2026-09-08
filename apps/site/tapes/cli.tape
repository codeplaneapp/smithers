# The hero tape: smithers running this repository's own flows.
# Record with `sh scripts/record-tape.sh` from apps/site.
# The helper sets SMITHERS_TAPE_ROOT to an owned detached worktree.
Output apps/site/public/media/cli.gif
Output apps/site/public/media/cli.webm

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 15
Set Width 1200
Set Height 750
Set Padding 24
Set Theme {"name":"Night Owl","background":"#011627","foreground":"#d6deeb","cursor":"#c792ea","selection":"#1d3b53","black":"#011627","red":"#ef5350","green":"#addb67","yellow":"#ecc48d","blue":"#82aaff","magenta":"#c792ea","cyan":"#7fdbca","white":"#d6deeb","brightBlack":"#5f7e97","brightRed":"#ef5350","brightGreen":"#addb67","brightYellow":"#ecc48d","brightBlue":"#82aaff","brightMagenta":"#c792ea","brightCyan":"#7fdbca","brightWhite":"#ffffff"}
Set Framerate 15
Set PlaybackSpeed 3.0
Set TypingSpeed 40ms
Set WindowBar Colorful
Set BorderRadius 12
Set CursorBlink true

Hide
Type `cd "${SMITHERS_TAPE_ROOT:?Run scripts/record-tape.sh}"; export PS1='\[\e[38;5;183m\]❯\[\e[0m\] '; clear`
Enter
Show

Type "smithers ls"
Sleep 200ms
Enter
Sleep 22s

Type `smithers up lint -d --data '{"args":"packages/smithers/src/Version.ts"}'`
Sleep 300ms
Enter
Sleep 50s

Type "smithers logs run-1 --follow"
Sleep 200ms
Enter
Sleep 85s
Ctrl+C
Sleep 1s

Type "clear"
Enter
Sleep 500ms
Type `smithers up review -d --data '{"args":"flows/"}'`
Sleep 300ms
Enter
Sleep 50s

Type `smithers up release-notes -d --data '{"args":"last 8"}'`
Sleep 300ms
Enter
Sleep 50s

Type "smithers ps"
Enter
Sleep 20s

Type "smithers status run-1"
Enter
Sleep 6s

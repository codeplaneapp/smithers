import type { CommandEntry } from "../state/CommandRegistry"

/*
 * The slash-command menu: a preview list of matching commands shown above
 * the composer while the draft starts with "/". `selectedIndex` is owned by
 * App.tsx (mirroring apps/ui's App.tsx slash-menu state: `{draft, index,
 * dismissed}`, reset whenever the draft changes) — this component only
 * renders the highlight, it does not track it. See App.tsx's useKeyboard
 * handler for what Up/Down/Tab/Enter/Escape actually do.
 */
export const SlashMenu = ({
  entries,
  selectedIndex
}: {
  readonly entries: ReadonlyArray<CommandEntry>
  readonly selectedIndex: number
}) => {
  if (entries.length === 0) return null
  return (
    <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
      {entries.map((entry, index) => {
        const active = index === selectedIndex
        return (
          <text key={entry.name}>
            <span fg={active ? "#e0af68" : "#565f89"}>{active ? "❯ " : "  "}</span>
            <span fg={active ? "#e0af68" : "#7aa2f7"}>{`/${entry.name}`}</span>
            <span fg="#565f89">{`  ${entry.metadata.summary}`}</span>
          </text>
        )
      })}
    </box>
  )
}

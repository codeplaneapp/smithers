import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useState, useSyncExternalStore } from "react"
import type { ChatController } from "../state/ChatController"
import { Composer } from "./Composer"
import { SlashMenu } from "./SlashMenu"
import { Transcript } from "./Transcript"

/*
 * The app shell: transcript over composer over a one-line status bar, sized
 * to the terminal. Structural idea copied from the opencode TUI reference
 * (reference/opencode/packages/tui/src/app.tsx): one root column box pinned
 * to the terminal dimensions with the scroll region growing and the input
 * region flexShrink=0. Deviations: no routes, dialogs, toasts, or sidebar.
 */

/**
 * Slash-menu keyboard state, mirroring apps/ui's App.tsx `slashMenu` state
 * exactly: `{draft, index, dismissed}`, reset whenever the draft changes
 * (see `live` below). The menu's entries are derived from the draft on every
 * render, not owned here — this only layers "which one is highlighted" and
 * "did the user dismiss it" on top.
 */
interface SlashMenuState {
  readonly draft: string
  readonly index: number
  readonly dismissed: boolean
}

const INITIAL_SLASH_MENU: SlashMenuState = { draft: "", index: 0, dismissed: false }

export const App = ({
  controller,
  describe
}: {
  readonly controller: ChatController
  readonly describe: string
}) => {
  const { width, height } = useTerminalDimensions()
  useSyncExternalStore(controller.store.subscribe, controller.store.getVersion)
  const [slashMenu, setSlashMenu] = useState(INITIAL_SLASH_MENU)

  const draft = controller.store.draft()
  const matches = draft.startsWith("/") && controller.store.phase() === "idle"
    ? controller.commands.slashItems(draft.slice(1))
    : []
  const live = slashMenu.draft === draft ? slashMenu : { draft, index: 0, dismissed: false }
  const menuOpen = matches.length > 0 && !live.dismissed
  const highlighted = Math.min(live.index, matches.length - 1)

  useKeyboard((key) => {
    if (!menuOpen) {
      if (key.name === "escape") controller.cancelActive()
      return
    }
    if (key.name === "down") {
      key.preventDefault()
      setSlashMenu({ draft, index: (highlighted + 1) % matches.length, dismissed: false })
      return
    }
    if (key.name === "up") {
      key.preventDefault()
      setSlashMenu({ draft, index: (highlighted + matches.length - 1) % matches.length, dismissed: false })
      return
    }
    if (key.name === "tab") {
      // Complete without running: fills the composer so args can follow.
      key.preventDefault()
      const entry = matches[highlighted]
      if (entry !== undefined) controller.store.setDraft(`/${entry.name} `)
      return
    }
    if (key.name === "return") {
      // Matches apps/ui's slash menu: Enter on a highlighted entry runs it
      // directly rather than only completing the text.
      key.preventDefault()
      const entry = matches[highlighted]
      if (entry !== undefined) void controller.submit(`/${entry.name}`)
      return
    }
    if (key.name === "escape") {
      // Dismiss the overlay only; the draft text is left as-is, matching
      // apps/ui (Escape there doesn't clear the composer either).
      key.preventDefault()
      setSlashMenu({ draft, index: highlighted, dismissed: true })
    }
  })

  return (
    <box width={width} height={height} flexDirection="column">
      <Transcript store={controller.store} />
      <SlashMenu entries={menuOpen ? matches : []} selectedIndex={highlighted} />
      <Composer
        phase={controller.store.phase()}
        value={controller.store.draft()}
        inputKey={controller.store.draftRevision()}
        onInput={controller.store.setDraft}
        onSubmit={(text) => {
          void controller.submit(text)
        }}
      />
      <box flexShrink={0} height={1} paddingLeft={1}>
        <text fg="#565f89">{`${describe} · Enter sends · Esc cancels · Ctrl+C exits`}</text>
      </box>
    </box>
  )
}

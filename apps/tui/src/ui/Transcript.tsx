import { useSyncExternalStore } from "react"
import { scrubToolEcho } from "../state/MessageScrub"
import { cardPlaceholder, toolCallLine } from "../state/Transcript"
import type { MessageEntry, TranscriptStore } from "../state/Transcript"

/*
 * The transcript projection: a sticky-bottom scroll area rendering the
 * store's entries. Components are projections — every byte rendered here is
 * derived from TranscriptStore state at render time.
 *
 * Structural ideas copied from the opencode TUI reference
 * (reference/opencode/packages/tui/src/routes/session/index.tsx): a
 * <scrollbox> with stickyScroll/stickyStart="bottom" as the transcript, user
 * and assistant messages rendered per role. Deviations: @opentui/react in
 * place of @opentui/solid, no dialogs, no revert UI, cards as one-line
 * placeholders.
 */

const MessageLine = ({ entry }: { readonly entry: MessageEntry }) => {
  if (entry.role === "user") {
    return (
      <box flexShrink={0} marginTop={1}>
        <text>
          <span fg="#7aa2f7">
            <strong>{"> "}</strong>
          </span>
          {entry.text}
        </text>
      </box>
    )
  }
  const visible = scrubToolEcho(entry.text)
  return (
    <box flexShrink={0} flexDirection="column" marginTop={1}>
      {entry.reasoning !== undefined && entry.reasoning !== "" && (
        <text fg="#565f89">
          <em>{entry.reasoning}</em>
        </text>
      )}
      {visible !== "" && <text>{visible}</text>}
      {entry.status === "streaming" && <text fg="#565f89">…</text>}
      {(entry.status === "failed" || entry.status === "interrupted") && (
        <text fg="#e0af68">{entry.detail ?? entry.status}</text>
      )}
    </box>
  )
}

export const Transcript = ({ store }: { readonly store: TranscriptStore }) => {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const entries = store.entries()
  return (
    <scrollbox stickyScroll stickyStart="bottom" flexGrow={1} minHeight={0}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {entries.map((entry) => {
          switch (entry.kind) {
            case "message":
              return <MessageLine key={entry.id} entry={entry} />
            case "tool":
              return (
                <box key={entry.id} flexShrink={0}>
                  <text fg="#9ece6a">{toolCallLine(entry)}</text>
                </box>
              )
            case "card":
              // TODO(open-in-app): render a link that opens this card in the native app
              return (
                <box key={entry.id} flexShrink={0}>
                  <text fg="#bb9af7">{cardPlaceholder(entry)}</text>
                </box>
              )
            case "event":
              return (
                <box key={entry.id} flexShrink={0}>
                  <text fg="#565f89">{entry.text}</text>
                </box>
              )
          }
        })}
      </box>
    </scrollbox>
  )
}

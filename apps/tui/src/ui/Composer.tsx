import type { ChatPhase } from "../state/Transcript"

/*
 * The composer: a bordered single-line input at the bottom of the screen.
 * Enter submits; while a turn is responding the input stays visible but
 * submissions are refused by the controller (Esc cancels the turn).
 *
 * Structural idea copied from the opencode TUI reference
 * (reference/opencode/packages/tui/src/component/prompt/index.tsx): a focused
 * input owned by the chat route with submit routed to the session controller.
 * Deviations: single-line <input> instead of the multiline prompt editor, no
 * autocomplete/history.
 */
export const Composer = ({
  phase,
  value,
  inputKey,
  onInput,
  onSubmit
}: {
  readonly phase: ChatPhase
  readonly value: string
  readonly inputKey: number
  readonly onInput: (value: string) => void
  readonly onSubmit: (text: string) => void
}) => {
  const responding = phase === "responding"
  return (
    <box
      flexShrink={0}
      height={3}
      border
      borderColor={responding ? "#565f89" : "#7aa2f7"}
      paddingLeft={1}
    >
      <input
        key={inputKey}
        focused
        value={value}
        placeholder={responding ? "responding… (Esc to cancel)" : "message"}
        onInput={onInput}
        onSubmit={(submitted) => {
          // The JSX catalogue combines the core and React callback shapes;
          // InputRenderable emits the controlled string value at runtime.
          if (typeof submitted !== "string") return
          if (responding || submitted.trim() === "") return
          onSubmit(submitted)
        }}
      />
    </box>
  )
}

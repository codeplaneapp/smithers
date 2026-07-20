import { Component, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";

type Props = {
  children?: ReactNode;
  /**
   * Teardown to run when the user quits the crash screen. The renderer is
   * created with `exitOnCtrlC:false`, so a crashed UI has no built-in escape —
   * without this the terminal stays in raw mode and the user is wedged. Routed
   * through the same `onExit` the app uses so the React tree unmounts and the
   * renderer restores cooked mode before exit.
   */
  onExit?: (code: number) => void;
};
type State = { error: Error | null };

/**
 * Crash screen with a working exit. `useKeyboard` resolves the renderer's
 * keyHandler from the OpenTUI app context (installed above the whole user tree
 * by `createRoot`), so it keeps firing even though every mode component has been
 * replaced by this fallback — letting q/Ctrl-C tear the terminal down cleanly.
 */
function ErrorFallback({ error, onExit }: { error: Error; onExit?: (code: number) => void }) {
  useKeyboard((e) => {
    // Shift+Q arrives as { name: "q", shift: true } — parseKeypress lowercases
    // shifted letters, so a literal name "Q" never occurs.
    if ((e.name === "q" && !e.ctrl && !e.meta) || (e.ctrl && e.name === "c")) {
      onExit?.(1);
    }
  });
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg="red">{`Error: ${error.message}`}</text>
      <text fg="#888888">{"  The monitor hit a render error and stopped."}</text>
      <text fg="#888888">{"  [q] or Ctrl-C to quit"}</text>
    </box>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onExit={this.props.onExit} />;
    }
    return this.props.children;
  }
}

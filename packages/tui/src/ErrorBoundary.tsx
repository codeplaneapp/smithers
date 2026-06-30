import { Component, type ReactNode } from "react";

type Props = { children?: ReactNode };
type State = { error: Error | null };

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
      return <text fg="red">{`Error: ${this.state.error.message}`}</text>;
    }
    return this.props.children;
  }
}

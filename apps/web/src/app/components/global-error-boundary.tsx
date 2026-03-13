import { Component, type ErrorInfo, type ReactNode } from "react"

import { AppCrashScreen } from "@/app/components/app-crash-screen"

type GlobalErrorBoundaryProps = {
  children: ReactNode
}

type GlobalErrorBoundaryState = {
  error: Error | null
}

export class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  state: GlobalErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): GlobalErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Unhandled application error", error, errorInfo)
  }

  render() {
    if (this.state.error) {
      return (
        <AppCrashScreen
          message="The app crashed while rendering. Reload the window to try again."
          details={this.state.error.stack ?? this.state.error.message}
        />
      )
    }

    return this.props.children
  }
}

/**
 * The global shortcuts the Build page advertises: Esc stops a streaming turn,
 * Cmd/Ctrl+N starts a new one. Installed once at module load, not in a
 * `useEffect`, so no component owns a listener.
 */
import { navigate } from "./router.ts"
import { actions, store } from "./store.ts"

export const startShortcuts = (): void => {
  if (typeof window === "undefined") return
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && store.getSnapshot().status === "streaming") {
      event.preventDefault()
      actions.stop()
      return
    }
    if (event.key.toLowerCase() === "n" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      actions.newSession()
      navigate("/build")
    }
  })
}

/** The identity answer serialized into the Start document before React hydrates. */
export interface BootSession {
  readonly state: "signed-in" | "signed-out" | "unavailable"
  readonly login: string | null
  readonly allowlisted: boolean
  readonly admin: boolean
  /** A failed OAuth return was consumed by the server redirect. */
  readonly authFailed: boolean
}

export const unavailableBootSession = (authFailed = false): BootSession => ({
  state: "unavailable",
  login: null,
  allowlisted: false,
  admin: false,
  authFailed
})

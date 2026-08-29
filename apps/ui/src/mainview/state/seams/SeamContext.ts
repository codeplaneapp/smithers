/*
 * The context a domain seam factory receives from the controller: the tapped
 * fetch, the store, and the transcript helpers. Seams own one backend domain
 * each (issues, landings, keys, …), dispatch typed transitions, and answer
 * the command contract — an honest error string, or void on success. Cards
 * carry the substance; a seam never returns raw payloads to the transcript.
 */
import type { AppStore } from "../AppStore"

export type SeamFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface SeamContext {
  readonly http: SeamFetch
  readonly baseUrl: string
  readonly store: AppStore
  readonly dispatch: AppStore["dispatch"]
  /** The acting principal for dispatches: "user", or "smithers" under withAgentActor. */
  readonly actor: () => "user" | "smithers"
  /** The next transcript ordinal — new cards surface at the end, never mid-history. */
  readonly nextOrdinal: () => number
}

/**
 * The honest message out of a failed seam response, bounded and fallback-safe.
 *
 * ONLY a message the upstream addressed to a person is surfaced: the `message`
 * or `error` field of a JSON body. Anything else is transport plumbing with no
 * contract with this product — a router's `404 page not found`, an HTML error
 * page, a stack trace — and reads to the user as a debug string leaking through
 * the UI (§28.5). The caller's fallback already names what failed in the
 * product's own voice, so that is what a plumbing body gets.
 */
export const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const text = (await response.text().catch(() => "")).trim()
  if (text === "") return fallback
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown }
    if (typeof body.message === "string" && body.message !== "") return body.message.slice(0, 240)
    if (typeof body.error === "string" && body.error !== "") return body.error.slice(0, 240)
  } catch {
    // Not JSON at all: plumbing, never copy.
    return fallback
  }
  return fallback
}

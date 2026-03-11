import { BurnsClient } from "@mr-burns/client"

export const BURNS_API_URL = import.meta.env.VITE_BURNS_API_URL ?? "http://localhost:7332"

export const burnsClient = new BurnsClient(BURNS_API_URL)

export function isLocalhostBurnsApiUrl() {
  try {
    const parsedUrl = new URL(BURNS_API_URL, window.location.origin)
    return (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "::1"
    )
  } catch {
    return false
  }
}

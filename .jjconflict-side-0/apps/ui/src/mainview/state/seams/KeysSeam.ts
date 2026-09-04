/*
 * The BYOK keys seam: GET /api/user/byok-keys (masked) and
 * DELETE /api/user/byok-keys/{provider}. Adding a key needs a masked secret
 * form (a key typed into chat would persist in the transcript journal) — that
 * lands separately. Reference: multi src/smithersCloud/byokKeys.ts.
 */
import type { Card } from "../AppState"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

export interface KeysSeam {
  readonly listKeys: () => Promise<string | void>
  readonly removeKey: (provider: string) => Promise<string | void>
}

const BYOK_KEYS_PATH = "/api/user/byok-keys"

type MaskedKey = { readonly provider: string; readonly masked: string }

const str = (value: unknown): string => (typeof value === "string" ? value : "")

/** The list rows under any of the platform's field names (byokKeys.ts byokKeyArray). */
const keyRows = (body: unknown): unknown[] | null => {
  if (Array.isArray(body)) return body
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>
    if (Array.isArray(record.keys)) return record.keys
    if (Array.isArray(record.byok_keys)) return record.byok_keys
    if (Array.isArray(record.items)) return record.items
  }
  return null
}

/*
 * The secret law: only a masked preview may leave this function. A masked
 * field is taken as answered if the API sends one; otherwise a preview is
 * synthesized from the last4 variants byokKeys.ts parseByokKey reads; a row
 * with nothing maskable states the plain fact "configured". Raw key material
 * is never read off the row at all.
 */
const maskedPreview = (row: Record<string, unknown>): string => {
  const masked = str(row.masked ?? row.masked_key ?? row.maskedKey ?? row.preview).trim()
  if (masked !== "") return masked
  const last4 = str(row.last4 ?? row.last_4 ?? row.key_last4 ?? row.key_last_4).trim()
  return last4 === "" ? "configured" : `sk-…${last4}`
}

/** The card payload out of the platform answer, or null when malformed. */
const parseKeys = (body: unknown): MaskedKey[] | null => {
  const rows = keyRows(body)
  if (rows === null) return null
  const keys: MaskedKey[] = []
  for (const row of rows) {
    if (row === null || typeof row !== "object") return null
    const record = row as Record<string, unknown>
    const provider = str(record.provider).trim()
    if (provider === "") return null
    keys.push({ provider, masked: maskedPreview(record) })
  }
  return keys
}

export const createKeysSeam = (ctx: SeamContext): KeysSeam => {
  /*
   * One keys card, re-surfaced at the end of the transcript each time the
   * list is asked for — the balance-card law: leaving it at its old ordinal
   * would answer the command with a silent no-op.
   */
  const surfaceKeysCard = (keys: MaskedKey[]): void => {
    const card: Card = {
      id: "byok-keys",
      kind: "keys",
      title: "Provider keys",
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: { keys }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const listKeys = async (): Promise<string | void> => {
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}${BYOK_KEYS_PATH}`)
    } catch {
      return "Your provider keys couldn't be listed — the platform didn't answer."
    }
    if (!response.ok) {
      return readErrorMessage(response, "Your provider keys couldn't be listed right now.")
    }
    const body: unknown = await response.json().catch(() => undefined)
    const keys = body === undefined ? null : parseKeys(body)
    if (keys === null) return "The provider keys answer was malformed."
    surfaceKeysCard(keys)
  }

  const removeKey = async (provider: string): Promise<string | void> => {
    const normalized = provider.trim()
    if (normalized === "") return "keys.remove needs the provider name"
    let response: Response
    try {
      response = await ctx.http(
        `${ctx.baseUrl}${BYOK_KEYS_PATH}/${encodeURIComponent(normalized)}`,
        { method: "DELETE" }
      )
    } catch {
      return `The ${normalized} key couldn't be removed — the platform didn't answer.`
    }
    if (!response.ok) {
      return readErrorMessage(response, `The ${normalized} key couldn't be removed right now.`)
    }
    await response.body?.cancel()
    // The removal succeeded; re-list so the transcript states the new truth.
    const relisted = await listKeys()
    if (typeof relisted === "string") {
      return `The ${normalized} key was removed, but the key list couldn't be refreshed.`
    }
  }

  return { listKeys, removeKey }
}

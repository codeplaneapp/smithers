/**
 * Derives collision-proof machine names from session keys.
 *
 * @since 0.1.0
 */

/**
 * A collision-proof name fragment for a session key: the key's safe
 * characters for the operator reading a process or container list, plus a
 * stable digest of the whole key so `a/b` and `a-b` cannot share a machine.
 *
 * @category constructors
 * @since 0.1.0
 */
export const sessionSlug = (session: string): string => {
  let hash = 5381
  for (let index = 0; index < session.length; index++) {
    hash = ((hash << 5) + hash + session.charCodeAt(index)) >>> 0
  }
  const clean = session.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 48)
  return `${clean}-${hash.toString(16)}`
}

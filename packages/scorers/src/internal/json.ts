/**
 * Detects values that JSON serialization silently loses.
 *
 * A scorer's declared configuration is hashed into its durable `scorerKey`
 * through canonical JSON, and canonical JSON mirrors `JSON.stringify`: a
 * function, a symbol, an explicit `undefined` member, or a symbol-keyed
 * property disappears before the hash is taken. Two scorers whose declarations
 * differ only in such a member would then share one durable identity forever,
 * so the declaration is rejected instead of quietly collapsing.
 *
 * @since 1.0.0
 */

const lossOf = (value: unknown): string | undefined => {
  const type = typeof value
  if (type === "function" || type === "symbol" || type === "bigint") return type
  if (type === "undefined") return "undefined"
  if (type === "number" && !Number.isFinite(value)) return "a non-finite number"
  return undefined
}

const read = (node: object, key: string): { readonly value: unknown } | undefined => {
  try {
    return { value: (node as Record<string, unknown>)[key] }
  } catch {
    return undefined
  }
}

const hasToJson = (node: object): boolean => {
  const slot = read(node, "toJSON")
  return slot !== undefined && typeof slot.value === "function"
}

/**
 * Names the first member of `value` that canonical JSON would drop or reject.
 *
 * Returns `undefined` when the value round-trips losslessly. The returned
 * string is a path plus the reason, never the offending value itself, so a
 * declaration failure cannot leak a configuration into an error message.
 *
 * @category predicates
 * @since 1.0.0
 */
export const lossyPath = (value: unknown, root: string): string | undefined => {
  const open = new Set<object>()
  const walk = (node: unknown, path: string): string | undefined => {
    const loss = lossOf(node)
    if (loss !== undefined) return `${path} is ${loss}`
    if (node === null || typeof node !== "object") return undefined
    if (open.has(node)) return `${path} is circular`
    open.add(node)
    try {
      if (hasToJson(node)) return undefined
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index += 1) {
          const slot = read(node, String(index))
          if (slot === undefined) return `${path}[${index}] throws when read`
          const found = walk(slot.value, `${path}[${index}]`)
          if (found !== undefined) return found
        }
        return undefined
      }
      if (Object.getOwnPropertySymbols(node).length > 0) return `${path} has a symbol-keyed property`
      for (const key of Object.keys(node)) {
        const slot = read(node, key)
        if (slot === undefined) return `${path}.${key} throws when read`
        const found = walk(slot.value, `${path}.${key}`)
        if (found !== undefined) return found
      }
      return undefined
    } finally {
      open.delete(node)
    }
  }
  return walk(value, root)
}

/**
 * Conservative effect-tier inference for statically projected authority.
 *
 * Implements the capability implications in
 * [Effect Taxonomy](../../../../docs/specs/Concepts/Effect%20Taxonomy.md).
 *
 * @since 0.1.0
 */
import type { EffectTier } from "../Descriptor.ts"

const tierRank: Record<EffectTier, number> = {
  sealed: 0,
  compensable: 1,
  irreversible: 2
}

const sealedActions = ["fs:read", "net:get", "model:call", "jj:status", "jj:diff"] as const

/**
 * Returns the more conservative of two effect tiers.
 *
 * @category authority
 * @since 0.1.0
 */
export const maxTier = (left: EffectTier, right: EffectTier): EffectTier =>
  tierRank[left] >= tierRank[right] ? left : right

const tierForCapability = (capability: string): EffectTier => {
  const normalized = capability.toLowerCase()
  if (
    normalized === "read" ||
    normalized === "grep" ||
    normalized === "glob" ||
    normalized === "ls" ||
    sealedActions.some((action) => normalized === action || normalized.startsWith(`${action}:`))
  ) {
    return "sealed"
  }
  if (normalized.startsWith("fs:write:")) {
    const resource = capability.slice("fs:write:".length).trim().replaceAll("\\", "/")
    if (
      resource.length > 0 &&
      !resource.startsWith("/") &&
      !/^[A-Za-z]:\//.test(resource)
    ) {
      let depth = 0
      for (const segment of resource.split("/")) {
        if (segment === "" || segment === ".") {
          continue
        }
        if (segment === "..") {
          if (depth === 0) {
            return "irreversible"
          }
          depth--
        } else {
          depth++
        }
      }
      return "compensable"
    }
  }
  return "irreversible"
}

/**
 * Infers a conservative tier from projected capabilities. Unknown authority,
 * including wildcard, shell tools, and unscoped writes, is irreversible. Only
 * an explicit workspace-relative `fs:write:<resource>` scope proves that a
 * file write is compensable during registry discovery.
 *
 * @category authority
 * @since 0.1.0
 */
export const inferEffectTier = (capabilities: ReadonlyArray<string>): EffectTier =>
  capabilities.reduce<EffectTier>(
    (tier, capability) => maxTier(tier, tierForCapability(capability)),
    "sealed"
  )

import type { FleetTierModels } from "./FleetTierModels";

/**
 * The Opus-and-weaker delegation matrix: Opus plans and reviews, Opus delegates
 * to Opus for smart work, and delegates down to Sonnet for the implementation
 * middle, with Haiku on previews. This is the direct Claude-only substitution
 * for the Fable Sandwich the seeded delegation-chain uses by default.
 */
export const defaultFleetTierModels: FleetTierModels = {
  strong: "claude-opus-4-8",
  smart: "claude-opus-4-8",
  implement: "claude-sonnet-5",
  cheap: "claude-haiku-4-5",
};

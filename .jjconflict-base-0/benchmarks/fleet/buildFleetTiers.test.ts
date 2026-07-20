import { describe, expect, it } from "bun:test";
import { buildFleetTiers } from "./buildFleetTiers";
import { defaultFleetTierModels } from "./defaultFleetTierModels";

describe("buildFleetTiers", () => {
  it("exposes the four delegation tiers, one Claude agent each", () => {
    const tiers = buildFleetTiers();
    expect(Object.keys(tiers).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
    for (const key of ["fable", "opus", "sonnet", "haiku"] as const) {
      expect(tiers[key]).toHaveLength(1);
      const agent = tiers[key][0];
      expect(agent).toBeTruthy();
      // ClaudeCodeAgent, so the whole fleet stays Opus-and-weaker.
      expect(agent.constructor.name).toBe("ClaudeCodeAgent");
    }
  });

  it("defaults to Opus at the strong end and Sonnet to implement", () => {
    expect(defaultFleetTierModels.strong).toBe("claude-opus-4-8");
    expect(defaultFleetTierModels.smart).toBe("claude-opus-4-8");
    expect(defaultFleetTierModels.implement).toBe("claude-sonnet-5");
    expect(defaultFleetTierModels.cheap).toBe("claude-haiku-4-5");
  });

  it("accepts per-subscription auth without throwing", () => {
    expect(() => buildFleetTiers({ token: "sk-oauth-xyz", cwd: "/tmp/checkout" })).not.toThrow();
    expect(() => buildFleetTiers({ configDir: "/home/u/.smithers/accounts/claude-1" })).not.toThrow();
  });

  it("honors model overrides", () => {
    const tiers = buildFleetTiers({ models: { implement: "claude-opus-4-8" } });
    expect(tiers.sonnet[0].constructor.name).toBe("ClaudeCodeAgent");
  });
});

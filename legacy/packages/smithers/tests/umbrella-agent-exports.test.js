// Guards the `smthrs` umbrella against type-vs-runtime export drift.
//
// The declaration bundle is generated from @smthrs/agents, so a symbol can be
// *typed* as exported from "smthrs" while the hand-maintained re-export list in
// src/index.js never got the matching entry. That combination typechecks and
// then throws at load time — `fallbackAgents` shipped exactly that way: the
// documented import `import { fallbackAgents } from "smthrs"` failed with
// "Export named 'fallbackAgents' not found in module 'smthrs'" for every
// workflow that followed the docs. check-dts cannot catch it (it regenerates
// declarations from the same source), so assert the runtime surface directly.
import { describe, expect, test } from "bun:test";
import * as agents from "@smthrs/agents";
import * as smithers from "smthrs";

// Public agent-facing values every workflow author is documented to import from
// the umbrella. Extend when a new agent/helper joins the public API.
const PUBLIC_AGENT_EXPORTS = [
  "AnthropicAgent",
  "ClaudeCodeAgent",
  "CodexAgent",
  "GeminiAgent",
  "KimiAgent",
  "OpenCodeAgent",
  "PoolAgent",
  "fallbackAgents",
];

describe("smthrs umbrella agent exports", () => {
  for (const name of PUBLIC_AGENT_EXPORTS) {
    test(`re-exports ${name} at runtime`, () => {
      expect(smithers[name]).toBeDefined();
    });

    test(`${name} is the same binding as @smthrs/agents`, () => {
      expect(smithers[name]).toBe(agents[name]);
    });
  }

  // The regression that motivated this file: fallbackAgents must be callable
  // and degrade to a non-empty chain even with no registered accounts, since
  // workflows using it must still run on machines with an empty registry.
  test("fallbackAgents() returns a usable chain without a registry", () => {
    const chain = smithers.fallbackAgents({ seed: "umbrella-export-test" });
    expect(Array.isArray(chain)).toBe(true);
    expect(chain.length).toBeGreaterThan(0);
  });
});

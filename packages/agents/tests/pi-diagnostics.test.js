import { describe, expect, test } from "bun:test";
import { diagnosticApiKeyEnv, getDiagnosticStrategy } from "../src/diagnostics/getDiagnosticStrategy.js";

/**
 * @param {ReturnType<typeof getDiagnosticStrategy>} strategy
 */
function apiKeyCheck(strategy) {
    return strategy?.checks.find((check) => check.id === "api_key_valid");
}

describe("Pi diagnostics provider mapping", () => {
    test("defaults to Google checks", () => {
        const strategy = getDiagnosticStrategy("pi");
        expect(strategy).not.toBeNull();
        expect(strategy.checks).toHaveLength(3);
        expect(strategy.checks.map((check) => check.id)).toEqual([
            "cli_installed",
            "api_key_valid",
            "rate_limit_status",
        ]);
    });
    test("uses OpenAI checks for provider hint", async () => {
        const check = apiKeyCheck(getDiagnosticStrategy("pi", { provider: "openai" }));
        const result = await check.run({ env: {}, cwd: "/tmp" });
        expect(result.message).toContain("OPENAI_API_KEY");
    });
    test("uses Anthropic checks for provider hint", async () => {
        const check = apiKeyCheck(getDiagnosticStrategy("pi", { provider: "anthropic" }));
        const result = await check.run({ env: {}, cwd: "/tmp" });
        expect(result.message).toContain("ANTHROPIC_API_KEY");
    });
    test("infers OpenAI checks from provider/model prefix", async () => {
        const check = apiKeyCheck(getDiagnosticStrategy("pi", { model: "openai/gpt-4o" }));
        const result = await check.run({ env: {}, cwd: "/tmp" });
        expect(result.message).toContain("OPENAI_API_KEY");
    });
    test("infers OpenAI checks from a bare gpt- model id", async () => {
        const check = apiKeyCheck(getDiagnosticStrategy("pi", { model: "gpt-4o" }));
        const result = await check.run({ env: {}, cwd: "/tmp" });
        expect(result.message).toContain("OPENAI_API_KEY");
    });
    test("infers Anthropic checks from a bare claude- model id", async () => {
        const check = apiKeyCheck(getDiagnosticStrategy("pi", { model: "claude-3-5-sonnet" }));
        const result = await check.run({ env: {}, cwd: "/tmp" });
        expect(result.message).toContain("ANTHROPIC_API_KEY");
    });
    test("keeps Google checks for a bare gemini- model id", () => {
        const strategy = getDiagnosticStrategy("pi", { model: "gemini-2.5-flash" });
        expect(strategy.checks.map((check) => check.id)).toEqual([
            "cli_installed",
            "api_key_valid",
            "rate_limit_status",
        ]);
        // The Google api_key check is the one that reads GOOGLE_API_KEY/GEMINI_API_KEY.
        expect(diagnosticApiKeyEnv("pi", { model: "gemini-2.5-flash", apiKey: "g" }))
            .toEqual({ GOOGLE_API_KEY: "g" });
    });
    test("maps a bare gpt- model id apiKey to OPENAI_API_KEY", () => {
        expect(diagnosticApiKeyEnv("pi", { model: "gpt-4o", apiKey: "sk-x" }))
            .toEqual({ OPENAI_API_KEY: "sk-x" });
    });
    test("maps the pi --api-key option to the provider's env var", () => {
        expect(diagnosticApiKeyEnv("pi", { provider: "openai", apiKey: "sk-openai" }))
            .toEqual({ OPENAI_API_KEY: "sk-openai" });
        expect(diagnosticApiKeyEnv("pi", { provider: "anthropic", apiKey: "sk-anthropic" }))
            .toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
        expect(diagnosticApiKeyEnv("pi", { model: "openai/gpt-4o", apiKey: "sk-x" }))
            .toEqual({ OPENAI_API_KEY: "sk-x" });
        expect(diagnosticApiKeyEnv("pi", { provider: "google", apiKey: "g-key" }))
            .toEqual({ GOOGLE_API_KEY: "g-key" });
        // No apiKey, non-pi command, or undefined hints → nothing to inject.
        expect(diagnosticApiKeyEnv("pi", { provider: "openai" })).toBeUndefined();
        expect(diagnosticApiKeyEnv("claude", { apiKey: "x" })).toBeUndefined();
    });
});

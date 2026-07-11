import { describe, expect, test } from "bun:test";
import {
    credentialSecretValues,
    redactSecretText,
    sanitizeErrorCause,
} from "../src/core/redactSecrets.js";

describe("credential secret redaction", () => {
    test("retains complete wire values and strips supported credential schemes", () => {
        const secrets = credentialSecretValues(
            undefined,
            null,
            "",
            "raw-token",
            "Bearer provider-token",
            "Basic\tencoded-token",
            "Token\u00a0unicode-space-token",
        );

        expect(secrets).toContain("raw-token");
        expect(secrets).toContain("Bearer provider-token");
        expect(secrets).toContain("provider-token");
        expect(secrets).toContain("Basic\tencoded-token");
        expect(secrets).toContain("encoded-token");
        expect(secrets).toContain("Token\u00a0unicode-space-token");
        expect(secrets).toContain("unicode-space-token");
        expect(secrets.every((secret, index) => index === 0 || secrets[index - 1].length >= secret.length)).toBe(true);
    });

    test("preserves line-break and whitespace-only edge-case handling", () => {
        expect(credentialSecretValues("Bearer\nprovider-token")).toContain("provider-token");
        expect(credentialSecretValues("Bearer provider\ntoken")).toEqual(["Bearer provider\ntoken"]);
        expect(credentialSecretValues("Bearer provider-token\n")).toEqual(["Bearer provider-token\n"]);
        expect(credentialSecretValues("Bearer   ")).toEqual(["Bearer   ", " "]);
    });

    test("handles adversarial whitespace in bounded time", () => {
        const malformed = `Bearer ${" ".repeat(250_000)}\n`;
        const startedAt = performance.now();
        const secrets = credentialSecretValues(malformed);

        expect(secrets).toEqual([malformed]);
        expect(performance.now() - startedAt).toBeLessThan(250);
    });

    test("redacts longest forms first and sanitizes surfaced error causes", () => {
        const secrets = credentialSecretValues("Bearer provider-token");
        expect(redactSecretText(
            "authorization=Bearer provider-token raw=provider-token",
            secrets,
        )).toBe("authorization=[REDACTED] raw=[REDACTED]");

        const cause = new TypeError("request exposed Bearer provider-token");
        const safeCause = sanitizeErrorCause(cause, secrets);
        expect(safeCause).not.toBe(cause);
        expect(safeCause.name).toBe("TypeError");
        expect(safeCause.message).toBe("request exposed [REDACTED]");
    });
});

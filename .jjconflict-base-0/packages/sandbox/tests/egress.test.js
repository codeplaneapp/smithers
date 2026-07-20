import { describe, expect, test } from "bun:test";
import {
    normalizeSandboxEgressConfig,
    redactSandboxEgressConfig,
    sandboxEgressEnv,
} from "../src/egress.js";

describe("sandbox egress config", () => {
    test("normalizes absent and empty configs to undefined", () => {
        expect(normalizeSandboxEgressConfig(undefined)).toBeUndefined();
        expect(normalizeSandboxEgressConfig(null)).toBeUndefined();
        expect(normalizeSandboxEgressConfig(false)).toBeUndefined();
        expect(normalizeSandboxEgressConfig({ env: {}, secretBindings: {} })).toBeUndefined();
    });

    test("normalizes string records, no_proxy arrays, and CA env", () => {
        const caCertPem = "-----BEGIN CERTIFICATE-----\nproxy-ca\n-----END CERTIFICATE-----\n";
        expect(
            normalizeSandboxEgressConfig({
                env: { SAFE_TOKEN: "token" },
                httpProxy: "http://127.0.0.1:8080",
                httpsProxy: "http://127.0.0.1:8443",
                noProxy: ["127.0.0.1", "localhost"],
                caCertPem,
                secretBindings: { "secret-id": "ANTHROPIC_API_KEY" },
            }),
        ).toEqual({
            env: { SAFE_TOKEN: "token" },
            httpProxy: "http://127.0.0.1:8080",
            httpsProxy: "http://127.0.0.1:8443",
            noProxy: "127.0.0.1,localhost",
            caCertPem,
            secretBindings: { "secret-id": "ANTHROPIC_API_KEY" },
        });
        expect(
            sandboxEgressEnv({
                env: { SAFE_TOKEN: "token" },
                httpsProxy: "http://127.0.0.1:8443",
                noProxy: "localhost",
                caCertPem,
            }),
        ).toEqual({
            SAFE_TOKEN: "token",
            HTTPS_PROXY: "http://127.0.0.1:8443",
            NO_PROXY: "localhost",
            NODE_EXTRA_CA_CERTS: "/workspace/.smithers/egress/ca.crt",
        });
    });

    test("secret bindings never leak into the sandbox process env", () => {
        // secretBindings are proxy-side material: the proxy substitutes them on
        // outbound requests. They must NEVER be handed to the sandbox process
        // (otherwise the agent could read the raw secret), so sandboxEgressEnv
        // must not surface any secretBindings key or value.
        const env = sandboxEgressEnv({
            httpsProxy: "http://127.0.0.1:8080",
            secretBindings: { "sk-real-anthropic-key": "ANTHROPIC_API_KEY" },
        });
        expect(env).toEqual({ HTTPS_PROXY: "http://127.0.0.1:8080" });
        const serialized = JSON.stringify(env);
        expect(serialized).not.toContain("sk-real-anthropic-key");
        expect(serialized).not.toContain("secretBindings");
        // It must also not be promoted into the explicit env passthrough.
        const withExplicitEnv = sandboxEgressEnv({
            env: { SAFE: "ok" },
            secretBindings: { "sk-leak-me": "TOKEN" },
        });
        expect(withExplicitEnv).toEqual({ SAFE: "ok" });
        expect(JSON.stringify(withExplicitEnv)).not.toContain("sk-leak-me");
    });

    test("rejects malformed fields with useful validation errors", () => {
        expect(() => normalizeSandboxEgressConfig("proxy")).toThrow("Sandbox egress must be an object");
        expect(() => normalizeSandboxEgressConfig({ env: [] })).toThrow("egress.env must be a flat object");
        expect(() => normalizeSandboxEgressConfig({ env: { "bad-key": "value" } })).toThrow(
            "egress.env keys must be valid environment variable names",
        );
        expect(() => normalizeSandboxEgressConfig({ env: { SAFE: 1 } })).toThrow(
            "egress.env values must be strings",
        );
        expect(() => normalizeSandboxEgressConfig({ env: { [("A".repeat(513))]: "value" } })).toThrow(
            "egress.env keys must be strings within supported bounds",
        );
        expect(() => normalizeSandboxEgressConfig({ noProxy: 5 })).toThrow(
            "egress.noProxy must be a string or string array",
        );
        expect(() => normalizeSandboxEgressConfig({ noProxy: [".example.test", ""] })).toThrow(
            "egress.noProxy[1] must be a non-empty string",
        );
        expect(() =>
            normalizeSandboxEgressConfig({
                caCertPem: "pem",
                caCertPath: "/tmp/ca.crt",
            }),
        ).toThrow("either caCertPem or caCertPath");
    });

    test("redacts sorted egress values and hides secret binding names", () => {
        expect(
            redactSandboxEgressConfig({
                env: { Z_TOKEN: "z", A_TOKEN: "a" },
                httpProxy: "http://proxy",
                caCertPath: "/tmp/ca.crt",
                secretBindings: { "secret-two": "two", "secret-one": "one" },
            }),
        ).toEqual({
            env: { A_TOKEN: "[redacted]", Z_TOKEN: "[redacted]" },
            httpProxy: "[redacted]",
            caCertPath: "[redacted]",
            secretBindings: { binding_1: "[redacted]", binding_2: "[redacted]" },
        });
        expect(redactSandboxEgressConfig(false)).toBe(false);
    });
});

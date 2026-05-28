// ---------------------------------------------------------------------------
// Regression: buildUrl must preserve the server base path
//
// `new URL("/users/5", "https://api.example.com/v2")` discards the base
// path ("/v2") because the operation path is absolute. buildUrl now joins
// the server base path with the operation path so specs whose server URL
// carries a base path hit the correct endpoint instead of a 404.
// ---------------------------------------------------------------------------
import { describe, test, expect } from "bun:test";
import { buildUrl } from "../src/tool-factory/_helpers.js";

const noOptions = {};

describe("buildUrl preserves server base path", () => {
    test("base with path component is retained (no trailing slash)", () => {
        const url = buildUrl(
            "https://api.example.com/v2",
            "/users/{id}",
            { id: "5" },
            {},
            noOptions,
        );
        expect(url).toBe("https://api.example.com/v2/users/5");
    });

    test("base with path component is retained (trailing slash)", () => {
        const url = buildUrl(
            "https://api.example.com/v2/",
            "/users/{id}",
            { id: "5" },
            {},
            noOptions,
        );
        expect(url).toBe("https://api.example.com/v2/users/5");
    });

    test("multi-segment base path is retained", () => {
        const url = buildUrl(
            "https://api.example.com/api/v3",
            "/users/{id}",
            { id: "5" },
            {},
            noOptions,
        );
        expect(url).toBe("https://api.example.com/api/v3/users/5");
    });

    test("base without a path component still works", () => {
        const url = buildUrl(
            "https://api.example.com",
            "/users/{id}",
            { id: "5" },
            {},
            noOptions,
        );
        expect(url).toBe("https://api.example.com/users/5");
    });

    test("query params are appended after the base path is preserved", () => {
        const url = buildUrl(
            "https://api.example.com/v2",
            "/users",
            {},
            { limit: "10", tag: "dog" },
            noOptions,
        );
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe("https://api.example.com/v2/users");
        expect(parsed.searchParams.get("limit")).toBe("10");
        expect(parsed.searchParams.get("tag")).toBe("dog");
    });

    test("path params are substituted within a preserved base path", () => {
        const url = buildUrl(
            "https://api.example.com/v2",
            "/orgs/{org}/users/{id}",
            { org: "acme", id: "5" },
            {},
            noOptions,
        );
        expect(url).toBe("https://api.example.com/v2/orgs/acme/users/5");
    });

    test("apiKey-in-query auth still appends to a preserved base path", () => {
        const url = buildUrl(
            "https://api.example.com/v2",
            "/users/{id}",
            { id: "5" },
            {},
            { auth: { type: "apiKey", name: "api_key", value: "key123", in: "query" } },
        );
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe("https://api.example.com/v2/users/5");
        expect(parsed.searchParams.get("api_key")).toBe("key123");
    });
});

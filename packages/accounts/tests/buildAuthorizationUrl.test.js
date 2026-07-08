import { describe, expect, test } from "bun:test";
import { buildAuthorizationUrl, createPkcePair } from "../src/index.js";

const BASE_REQUEST = {
    authorizationEndpoint: "https://provider.example/oauth/authorize",
    clientId: "smithers-client",
    redirectUri: "https://app.example/oauth/callback",
    state: "state-123",
    codeChallenge: "challenge-123",
};

describe("buildAuthorizationUrl", () => {
    test("builds an authorization-code URL with PKCE parameters", () => {
        const url = new URL(buildAuthorizationUrl(BASE_REQUEST));

        expect(url.origin).toBe("https://provider.example");
        expect(url.pathname).toBe("/oauth/authorize");
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("client_id")).toBe(BASE_REQUEST.clientId);
        expect(url.searchParams.get("redirect_uri")).toBe(BASE_REQUEST.redirectUri);
        expect(url.searchParams.get("state")).toBe(BASE_REQUEST.state);
        expect(url.searchParams.get("code_challenge")).toBe(BASE_REQUEST.codeChallenge);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    test("space-joins array scopes into one scope parameter", () => {
        const url = new URL(buildAuthorizationUrl({
            ...BASE_REQUEST,
            scope: ["openid", "profile", "email"],
        }));

        expect(url.searchParams.get("scope")).toBe("openid profile email");
    });

    test("uses string scopes verbatim", () => {
        const url = new URL(buildAuthorizationUrl({
            ...BASE_REQUEST,
            scope: "openid profile offline_access",
        }));

        expect(url.searchParams.get("scope")).toBe("openid profile offline_access");
    });

    test("omits scope when it is absent or empty", () => {
        const withoutScope = new URL(buildAuthorizationUrl(BASE_REQUEST));
        const withEmptyString = new URL(buildAuthorizationUrl({
            ...BASE_REQUEST,
            scope: "",
        }));
        const withEmptyArray = new URL(buildAuthorizationUrl({
            ...BASE_REQUEST,
            scope: [],
        }));

        expect(withoutScope.searchParams.has("scope")).toBe(false);
        expect(withEmptyString.searchParams.has("scope")).toBe(false);
        expect(withEmptyArray.searchParams.has("scope")).toBe(false);
    });

    test("defaults codeChallengeMethod to S256 and honors explicit plain", () => {
        const defaultUrl = new URL(buildAuthorizationUrl(BASE_REQUEST));
        const plainUrl = new URL(buildAuthorizationUrl({
            ...BASE_REQUEST,
            codeChallengeMethod: "plain",
        }));

        expect(defaultUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(plainUrl.searchParams.get("code_challenge_method")).toBe("plain");
    });

    test("preserves endpoint query params and applies extra params last", () => {
        const url = new URL(buildAuthorizationUrl({
            ...BASE_REQUEST,
            authorizationEndpoint: "https://login.example/tenant/authorize?tenant=acme&prompt=consent",
            extraParams: {
                audience: "https://api.example",
                client_id: "tenant-client",
                response_type: "custom-code",
            },
        }));

        expect(url.searchParams.get("tenant")).toBe("acme");
        expect(url.searchParams.get("prompt")).toBe("consent");
        expect(url.searchParams.get("audience")).toBe("https://api.example");
        expect(url.searchParams.get("client_id")).toBe("tenant-client");
        expect(url.searchParams.get("response_type")).toBe("custom-code");
        expect(url.searchParams.get("redirect_uri")).toBe(BASE_REQUEST.redirectUri);
    });

    test("uses createPkcePair codeChallenge as the code_challenge parameter", () => {
        const pair = createPkcePair();
        const url = new URL(buildAuthorizationUrl({
            ...BASE_REQUEST,
            codeChallenge: pair.codeChallenge,
        }));

        expect(url.searchParams.get("code_challenge")).toBe(pair.codeChallenge);
    });

    test("throws TypeError for non-absolute or non-http authorization endpoints", () => {
        for (const authorizationEndpoint of [
            "/oauth/authorize",
            "provider.example/oauth/authorize",
            "ftp://provider.example/oauth/authorize",
            "mailto:admin@example.com",
        ]) {
            expect(() => buildAuthorizationUrl({
                ...BASE_REQUEST,
                authorizationEndpoint,
            })).toThrow(TypeError);
        }
    });

    test("throws TypeError for empty required string fields", () => {
        for (const field of ["clientId", "redirectUri", "state", "codeChallenge"]) {
            expect(() => buildAuthorizationUrl({
                ...BASE_REQUEST,
                [field]: "",
            })).toThrow(TypeError);
        }
    });
});

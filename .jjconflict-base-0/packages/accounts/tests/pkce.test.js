import { describe, expect, test } from "bun:test";
import { createCodeVerifier, createPkcePair, deriveCodeChallenge } from "../src/index.js";

const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const BASE64URL_NO_PADDING_PATTERN = /^[A-Za-z0-9\-_]+$/;

describe("PKCE", () => {
    test("createCodeVerifier returns a 43-character unreserved verifier", () => {
        const codeVerifier = createCodeVerifier();

        expect(codeVerifier).toHaveLength(43);
        expect(codeVerifier).toMatch(PKCE_VERIFIER_PATTERN);
    });

    test("createCodeVerifier enforces byte length bounds", () => {
        expect(createCodeVerifier(32)).toHaveLength(43);
        expect(createCodeVerifier(96)).toHaveLength(128);

        expect(() => createCodeVerifier(31)).toThrow(/32\.\.96/);
        expect(() => createCodeVerifier(97)).toThrow(/32\.\.96/);
        expect(() => createCodeVerifier(32.5)).toThrow(/integer/);
    });

    test("deriveCodeChallenge matches RFC 7636 Appendix B", () => {
        const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

        expect(deriveCodeChallenge(codeVerifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });

    test("deriveCodeChallenge returns base64url without padding", () => {
        const codeVerifier = createCodeVerifier();
        const codeChallenge = deriveCodeChallenge(codeVerifier);

        expect(codeChallenge).toHaveLength(43);
        expect(codeChallenge).toMatch(BASE64URL_NO_PADDING_PATTERN);
        expect(codeChallenge).not.toContain("=");
    });

    test("deriveCodeChallenge validates RFC 7636 verifier length and charset", () => {
        expect(() => deriveCodeChallenge("a".repeat(42))).toThrow(/43\.\.128/);
        expect(() => deriveCodeChallenge("a".repeat(129))).toThrow(/43\.\.128/);
        expect(() => deriveCodeChallenge(`${"a".repeat(42)}!`)).toThrow(/unreserved/);

        expect(deriveCodeChallenge(`${"a".repeat(41)}.~`)).toMatch(BASE64URL_NO_PADDING_PATTERN);
        expect(deriveCodeChallenge("a".repeat(128))).toMatch(BASE64URL_NO_PADDING_PATTERN);
    });

    test("createPkcePair returns an S256 pair", () => {
        const pair = createPkcePair(96);

        expect(pair.codeChallengeMethod).toBe("S256");
        expect(pair.codeVerifier).toHaveLength(128);
        expect(pair.codeVerifier).toMatch(PKCE_VERIFIER_PATTERN);
        expect(pair.codeChallenge).toBe(deriveCodeChallenge(pair.codeVerifier));
    });
});

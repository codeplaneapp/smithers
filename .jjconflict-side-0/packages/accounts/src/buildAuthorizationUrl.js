function parseAuthorizationEndpoint(authorizationEndpoint) {
    if (typeof authorizationEndpoint !== "string") {
        throw new TypeError("OAuth authorizationEndpoint must be an absolute http(s) URL");
    }

    let url;
    try {
        url = new URL(authorizationEndpoint);
    } catch {
        throw new TypeError("OAuth authorizationEndpoint must be an absolute http(s) URL");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("OAuth authorizationEndpoint must be an absolute http(s) URL");
    }

    return url;
}

function validateNonEmptyString(name, value) {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`OAuth ${name} must be a non-empty string`);
    }
}

function normalizeScope(scope) {
    if (Array.isArray(scope)) {
        const joinedScope = scope.join(" ");
        return joinedScope.length > 0 ? joinedScope : undefined;
    }

    if (typeof scope === "string" && scope.length > 0) {
        return scope;
    }

    return undefined;
}

/**
 * Builds an RFC 6749 authorization-code request URL with RFC 7636 PKCE parameters.
 *
 * @param {{
 *     authorizationEndpoint: string;
 *     clientId: string;
 *     redirectUri: string;
 *     state: string;
 *     codeChallenge: string;
 *     scope?: string | readonly string[];
 *     codeChallengeMethod?: "S256" | "plain";
 *     extraParams?: Record<string, string>;
 * }} request
 * @returns {string}
 */
export function buildAuthorizationUrl(request) {
    const {
        authorizationEndpoint,
        clientId,
        redirectUri,
        state,
        codeChallenge,
        scope,
        codeChallengeMethod = "S256",
        extraParams,
    } = request;

    const url = parseAuthorizationEndpoint(authorizationEndpoint);
    validateNonEmptyString("clientId", clientId);
    validateNonEmptyString("redirectUri", redirectUri);
    validateNonEmptyString("state", state);
    validateNonEmptyString("codeChallenge", codeChallenge);

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", codeChallengeMethod);

    const normalizedScope = normalizeScope(scope);
    if (normalizedScope !== undefined) {
        url.searchParams.set("scope", normalizedScope);
    }

    if (extraParams !== undefined) {
        for (const [key, value] of Object.entries(extraParams)) {
            url.searchParams.set(key, value);
        }
    }

    return url.toString();
}

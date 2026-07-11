type HttpClientPolicyErrorCode$2 = "INVALID_URL" | "UNSUPPORTED_PROTOCOL" | "INVALID_OPTION" | "INVALID_REDIRECT" | "INSECURE_REDIRECT" | "TOO_MANY_REDIRECTS" | "UNREPLAYABLE_BODY" | "CROSS_ORIGIN_BODY_BLOCKED" | "REQUEST_TOO_LARGE" | "RESPONSE_TOO_LARGE";
type HttpClientPolicyErrorDetails$2 = Readonly<Record<string, unknown>>;
type HttpUrlValidationContext$1 = {
    readonly initial: boolean;
    readonly from?: URL;
};
type FetchWithPolicyOptions$1 = {
    /** Alternate Fetch implementation, primarily for platform adapters/tests. */
    fetch?: typeof globalThis.fetch;
    /**
     * Origins, in addition to the initial request origin, authorized to receive
     * sensitive headers/query parameters and preserved request bodies.
     */
    allowedOrigins?: readonly (string | URL)[];
    /** Additional case-insensitive header names stripped on unauthorized hops. */
    sensitiveHeaders?: readonly string[];
    /** Additional case-insensitive query parameter names stripped on unauthorized hops. */
    sensitiveQueryParams?: readonly string[];
    /** Maximum followed redirect hops. Defaults to 5. */
    maxRedirects?: number;
    /**
     * Optional destination policy invoked before every fetch, including every
     * redirect hop. It may perform async DNS/private-network validation.
     */
    validateUrl?: (url: URL, context: HttpUrlValidationContext$1) => void | Promise<void>;
};
type AbortSignalComposition$1 = {
    readonly signal: AbortSignal | undefined;
    cleanup(): void;
};
type ResponseReadOptions$1 = {
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
};
type AbortableDelayOptions$1 = {
    readonly maxMs?: number;
};

/**
 * Return whether a hostname is an IP literal outside ordinary public unicast
 * space. Hostnames return false: this helper deliberately performs no DNS
 * lookup, so callers must enforce DNS/private-range egress separately.
 *
 * IPv4 follows the IANA special-purpose registry's Globally Reachable field
 * and also rejects multicast. IPv6 permits 2000::/3, then applies the IANA
 * non-global ranges and more-specific global exceptions within that space.
 * IPv4-mapped and translation forms are rejected; callers can explicitly opt
 * in to an intentional internal/special endpoint at their policy layer.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
declare function isNonGlobalIpLiteral(hostname: string): boolean;

/**
 * Compose zero or more signals while preserving the exact winning abort reason.
 * Call cleanup when the surrounding operation settles so live source signals do
 * not retain listeners.
 *
 * @param {...(AbortSignal | null | undefined)} signals
 * @returns {import("./types.ts").AbortSignalComposition}
 */
declare function composeAbortSignals(...signals: (AbortSignal | null | undefined)[]): AbortSignalComposition$1;
/**
 * Resolve after a bounded delay or reject immediately with the source signal's
 * original abort reason.
 *
 * @param {number} ms
 * @param {AbortSignal | null | undefined} [signal]
 * @param {import("./types.ts").AbortableDelayOptions} [options]
 * @returns {Promise<void>}
 */
declare function abortableDelay(ms: number, signal?: AbortSignal | null | undefined, options?: AbortableDelayOptions$1): Promise<void>;

/**
 * @param {Response} response
 * @param {import("./types.ts").ResponseReadOptions} options
 * @returns {Promise<Uint8Array>}
 */
declare function readResponseBytes(response: Response, options: ResponseReadOptions$1): Promise<Uint8Array>;
/**
 * @param {Response} response
 * @param {import("./types.ts").ResponseReadOptions} options
 * @returns {Promise<string>}
 */
declare function readResponseText(response: Response, options: ResponseReadOptions$1): Promise<string>;
/**
 * @template [T=unknown]
 * @param {Response} response
 * @param {import("./types.ts").ResponseReadOptions} options
 * @returns {Promise<T>}
 */
declare function readResponseJson<T = unknown>(response: Response, options: ResponseReadOptions$1): Promise<T>;

/**
 * @param {unknown} value
 * @returns {value is HttpClientPolicyError}
 */
declare function isHttpClientPolicyError(value: unknown): value is HttpClientPolicyError;
/** @typedef {import("./types.ts").HttpClientPolicyErrorCode} HttpClientPolicyErrorCode */
/** @typedef {import("./types.ts").HttpClientPolicyErrorDetails} HttpClientPolicyErrorDetails */
/**
 * A deterministic policy/limit failure raised before unsafe outbound work can
 * continue. Messages deliberately omit URL query strings and userinfo.
 */
declare class HttpClientPolicyError extends Error {
    /**
     * @param {HttpClientPolicyErrorCode} code
     * @param {string} message
     * @param {HttpClientPolicyErrorDetails} [details]
     * @param {{ cause?: unknown }} [options]
     */
    constructor(code: HttpClientPolicyErrorCode$1, message: string, details?: HttpClientPolicyErrorDetails$1, options?: {
        cause?: unknown;
    });
    /** @type {HttpClientPolicyErrorCode} */
    code: HttpClientPolicyErrorCode$1;
    /** @type {HttpClientPolicyErrorDetails} */
    details: HttpClientPolicyErrorDetails$1;
}
type HttpClientPolicyErrorCode$1 = HttpClientPolicyErrorCode$2;
type HttpClientPolicyErrorDetails$1 = HttpClientPolicyErrorDetails$2;

/**
 * Fetch with an explicit, auditable redirect and credential policy. The
 * initial origin may receive sensitive material; an unauthorized cross-origin
 * hop is followed only after secrets are stripped, automatic credentials are
 * disabled, and any preserved request body is rejected. HTTPS downgrades are
 * always rejected. Every destination is passed through validateUrl before the
 * network call.
 *
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @param {import("./types.ts").FetchWithPolicyOptions} [options]
 * @returns {Promise<Response>}
 */
declare function fetchWithPolicy(input: string | URL | Request, init?: RequestInit, options?: FetchWithPolicyOptions$1): Promise<Response>;
declare const DEFAULT_MAX_REDIRECTS: 5;
declare const DEFAULT_SENSITIVE_HEADERS: readonly string[];

/**
 * Parse and enforce the only URL protocols Fetch callers in Smithers may use.
 * The thrown error never repeats the raw input, which may contain credentials.
 *
 * @param {string | URL} input
 * @returns {URL}
 */
declare function assertHttpUrl(input: string | URL): URL;
/**
 * A log/error-safe URL label. Paths can carry credentials (for example bot
 * tokens and signed webhook IDs), so generic diagnostics expose only origin.
 *
 * @param {URL} url
 * @returns {string}
 */
declare function safeUrlLabel(url: URL): string;

type AbortableDelayOptions = AbortableDelayOptions$1;
type AbortSignalComposition = AbortSignalComposition$1;
type FetchWithPolicyOptions = FetchWithPolicyOptions$1;
type HttpClientPolicyErrorCode = HttpClientPolicyErrorCode$2;
type HttpClientPolicyErrorDetails = HttpClientPolicyErrorDetails$2;
type HttpUrlValidationContext = HttpUrlValidationContext$1;
type ResponseReadOptions = ResponseReadOptions$1;

export { type AbortSignalComposition, type AbortableDelayOptions, DEFAULT_MAX_REDIRECTS, DEFAULT_SENSITIVE_HEADERS, type FetchWithPolicyOptions, HttpClientPolicyError, type HttpClientPolicyErrorCode, type HttpClientPolicyErrorDetails, type HttpUrlValidationContext, type ResponseReadOptions, abortableDelay, assertHttpUrl, composeAbortSignals, fetchWithPolicy, isHttpClientPolicyError, isNonGlobalIpLiteral, readResponseBytes, readResponseJson, readResponseText, safeUrlLabel };

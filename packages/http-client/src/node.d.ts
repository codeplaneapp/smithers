/**
 * Fail closed unless a hostname is localhost-free and every resolved A/AAAA
 * address is ordinary global unicast. IP literals are classified directly.
 *
 * This closes static DNS aliases to private ranges. Standard Fetch resolves
 * the hostname again, so callers must still enforce a private-range/metadata
 * deny at the network boundary to eliminate DNS-rebinding TOCTOU.
 *
 * @param {string} hostname
 * @param {{ resolveHostname?: HostnameResolver; signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
declare function assertPublicHostname(hostname: string, options?: {
    resolveHostname?: HostnameResolver;
    signal?: AbortSignal;
}): Promise<void>;
/**
 * Build a redirect-only destination guard for a configured provider endpoint.
 * The initial origin and explicitly allowed origins are operator trust and may
 * intentionally be private. Any other redirect must resolve entirely to
 * ordinary public-unicast space before Fetch may contact it.
 *
 * Fetch performs its own DNS lookup after this check, so deployments must still
 * deny private/metadata ranges at the network boundary to close rebinding TOCTOU.
 *
 * @param {string | URL} initialUrl
 * @param {{
 *   allowedOrigins?: readonly (string | URL)[];
 *   resolveHostname?: HostnameResolver;
 *   signal?: AbortSignal;
 * }} [options]
 * @returns {(url: URL, context: { readonly initial: boolean; readonly from?: URL }) => Promise<void>}
 */
declare function createPublicRedirectValidator(initialUrl: string | URL, options?: {
    allowedOrigins?: readonly (string | URL)[];
    resolveHostname?: HostnameResolver;
    signal?: AbortSignal;
}): (url: URL, context: {
    readonly initial: boolean;
    readonly from?: URL;
}) => Promise<void>;
type HostnameResolver = (hostname: string) => readonly string[] | Promise<readonly string[]>;

export { type HostnameResolver, assertPublicHostname, createPublicRedirectValidator };

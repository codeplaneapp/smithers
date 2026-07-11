export type CreateHttpToolOptions = {
  description?: string;
  /**
   * Headers merged into requests whose destination matches `baseUrl` or
   * `allowedHosts`. The model picks the request URL, so configuring non-empty
   * defaults requires at least one of those fail-closed destination gates.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * The API's base URL. Its exact origin (scheme, host, and port) gates
   * `defaultHeaders`, so an HTTPS configuration never authorizes HTTP on the
   * same host. `allowedHosts` can add explicit exact-origin exceptions.
   */
  baseUrl?: string;
  /**
   * Extra hosts allowed to receive `defaultHeaders`, in addition to the exact
   * `baseUrl` origin. A bare host (`api.example.com`,
   * `api.example.com:8443`) authorizes its HTTPS origin; a full HTTP(S) URL
   * is normalized to and authorizes only that exact origin.
   * Scheme and port never widen silently. At least one entry or `baseUrl` is
   * required when `defaultHeaders` is non-empty.
   */
  allowedHosts?: string[];
  /**
   * Exact origins allowed to retain credentials across redirects. The initial
   * request origin is always trusted. Other cross-origin redirects are
   * followed only after sensitive headers are stripped.
   */
  allowedOrigins?: string[];
  /** Maximum redirect hops. Defaults to 5. */
  maxRedirects?: number;
  /** Maximum decoded response bytes buffered into the tool result. Defaults to 1 MiB; must be a non-negative safe integer. */
  maxResponseBytes?: number;
  /**
   * Permit agent-selected localhost-style names, IP literals outside ordinary
   * public-unicast space, and hostnames resolving to non-global addresses. Off
   * by default. Prefer an exact destination entry for a specific trusted API.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Override Node/Bun DNS resolution used to reject hostnames whose A/AAAA
   * answers include non-global addresses. Useful for controlled runtimes and
   * deterministic tests. Resolution failures, empty answers, and malformed or
   * non-global answers are denied.
   */
  resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]>;
};

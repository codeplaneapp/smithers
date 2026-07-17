export type CreateHttpToolOptions = {
  description?: string;
  /**
   * Maximum number of response-body bytes the tool will buffer. Responses
   * larger than this are rejected to prevent model-selected endpoints from
   * exhausting process memory. Defaults to 1,048,576 bytes (1 MiB) and must
   * be a positive safe integer.
   */
  maxResponseBodyBytes?: number;
  /**
   * Backward-compatible alias for `maxResponseBodyBytes`. The canonical option
   * takes precedence when both are provided.
   *
   * @deprecated Use `maxResponseBodyBytes`.
   */
  maxResponseBytes?: number;
  /**
   * Headers merged into every request the tool makes. The model picks the
   * request URL, so when these carry secrets (API keys, cookies) pin them to
   * trusted hosts with `baseUrl`/`allowedHosts`; otherwise a model could point
   * the tool at an attacker host and leak them.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * The API's absolute HTTP(S) base URL. Its host joins the allowlist that
   * gates `defaultHeaders`, so configured secrets ride only to this host (and
   * any `allowedHosts`). Invalid values are rejected when the tool is created.
   */
  baseUrl?: string;
  /**
   * Extra hosts allowed to receive `defaultHeaders`, alongside `baseUrl`'s
   * host. Each entry is a bare host (`api.example.com`, `api.example.com:8443`)
   * or a full URL, matched as WHATWG `url.host`. When neither this nor `baseUrl`
   * is set the default headers are sent to every host (no restriction).
   *
   * The same allowlist gates redirect hops: caller headers, auth, and default
   * headers follow a redirect only when the hop stays on the original
   * request's origin or lands on an allowlisted host — any other cross-origin
   * hop is sent with no headers at all.
   */
  allowedHosts?: string[];
};

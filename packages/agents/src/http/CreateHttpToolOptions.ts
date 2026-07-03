export type CreateHttpToolOptions = {
  description?: string;
  /**
   * Headers merged into every request the tool makes. The model picks the
   * request URL, so when these carry secrets (API keys, cookies) pin them to
   * trusted hosts with `baseUrl`/`allowedHosts`; otherwise a model could point
   * the tool at an attacker host and leak them.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * The API's base URL. Its host joins the allowlist that gates
   * `defaultHeaders`, so configured secrets ride only to this host (and any
   * `allowedHosts`).
   */
  baseUrl?: string;
  /**
   * Extra hosts allowed to receive `defaultHeaders`, alongside `baseUrl`'s
   * host. Each entry is a bare host (`api.example.com`, `api.example.com:8443`)
   * or a full URL, matched as WHATWG `url.host`. When neither this nor `baseUrl`
   * is set the default headers are sent to every host (no restriction).
   */
  allowedHosts?: string[];
};

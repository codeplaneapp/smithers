/**
 * `IntegrationsConfig` is referenced inline rather than aliased through a local
 * `@typedef`. A `@typedef` is itself an export, so aliasing here would make both
 * this module and `./IntegrationsConfig.js` export the same name. `index.js`
 * re-exports both with `export *`, and a name exported by two star sources is
 * ambiguous, so the declaration bundler drops `IntegrationsConfig` from the
 * public types instead of emitting it.
 *
 * @typedef {object} ServerOptions
 * @property {number} [port]
 * @property {import("./IntegrationsConfig.js").IntegrationsConfig} [integrations] External integrations served by this process:
 *   generic HMAC-verified webhook sources exposed at `POST /v1/webhooks/:sourceId` and delivered
 *   to waiting runs through the integration runtime. Requires `db`.
 * @property {string} [host] Network interface to bind. Defaults to the loopback address 127.0.0.1.
 *   Binding a non-loopback host (e.g. 0.0.0.0) requires an authToken unless `insecure` is set,
 *   because the control plane can launch, cancel, and approve arbitrary workflow runs.
 * @property {boolean} [insecure] Allow binding a non-loopback host with no authToken configured.
 *   This exposes a full-control, unauthenticated HTTP control plane to the network. Defaults to false.
 * @property {unknown} [db]
 * @property {string} [authToken]
 * @property {number} [maxBodyBytes]
 * @property {string} [rootDir]
 * @property {boolean} [allowNetwork]
 * @property {number} [headersTimeout] Maximum time in milliseconds allowed for the HTTP parser to
 *   receive the complete headers of a single request. Helps mitigate slowloris attacks. Defaults to 30000.
 * @property {number} [requestTimeout] Maximum time in milliseconds allowed for a single request to be
 *   received and parsed, including the body. Helps mitigate slowloris attacks. Defaults to 60000.
 */

export {};

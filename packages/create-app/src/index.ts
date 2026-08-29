/**
 * `@smthrs/create-app`: declare a Smithers app in one `PACKAGE.ts`.
 *
 * An app is a directory with four kinds of file. `PACKAGE.ts` calls
 * {@link CreateApp}. `AGENT.ts`, `SANDBOX.ts`, and `TOOLS.ts` are layer files.
 * `flows/<id>/flow.ts` is a flow. `app/**\/page.tsx` and
 * `app/panes/<name>.tsx` are the UI. Nothing else names anything: the router
 * derives every route, every pane name, and every flow's three layers from
 * file location alone.
 *
 * This entry point re-exports the two halves of the authoring surface flat,
 * rather than as namespaces, because it is an authoring API rather than a
 * service API — an app writes `defineFlow`, not `App.defineFlow`.
 *
 * `./app` is browser-safe (layer files, flow files, types); `./package` is
 * Node-only (`CreateApp` over `@smthrs/targets`). `sideEffects: []` lets a
 * bundler drop the Node half from a browser or Worker bundle that imports only
 * `defineAgent` and friends.
 *
 * The other subpaths are `./ui` (panes and cards), `./router` (the file
 * router), `./runtime` (flows made executable), `./vite` (the plugin), and
 * `./testing` (`cachedModelTest`).
 *
 * @since 0.1.0
 */
export * from "./app.ts"
export * from "./package.ts"

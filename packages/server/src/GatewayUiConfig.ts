export type GatewayUiConfig = true | {
  /**
   * Browser entry module for the React app. Smithers bundles this with Bun and
   * serves it from the Gateway origin. Pass `true` to mount the built-in
   * operator console.
   */
  entry: string;
  /**
   * URL path where the UI is mounted. Gateway-level UI defaults to `/`;
   * workflow-level UI defaults to `/workflows/<workflowKey>`.
   */
  path?: string;
  /**
   * Document title for the generated HTML shell.
   */
  title?: string;
  /**
   * JSON-serializable boot data exposed to the browser.
   */
  props?: Record<string, unknown>;
};

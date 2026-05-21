export type GatewayOperatorUiConfig = {
  /**
   * URL path for the built-in operator console.
   * @default "/console"
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

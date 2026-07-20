/**
 * Stylesheets imported `with { type: "text" }` inline as plain strings at
 * bundle time (Bun.build; see packages/server/src/gatewayUi/bundle.js). The
 * monitor entry uses this for xterm.css.
 */
declare module "*.css" {
  const text: string;
  export default text;
}

/** @jsxImportSource react */
import { useInsertionEffect } from "react";
import { standaloneThemeCss, workflowUiThemeCss } from "@smithers-orchestrator/ui-styleguide";
import { smithersUiCss } from "./uiCss";

export { smithersUiCss } from "./uiCss";
export { standaloneThemeCss };

/**
 * Marker attribute carried by the injected/rendered style element. Both
 * delivery paths ({@link SmithersUiStyles} and the per-component
 * {@link useInjectUiCss} fallback) check for it, so the sheet lands exactly
 * once per document no matter how many components render.
 */
export const SMITHERS_UI_STYLE_ATTR = "data-smithers-ui";

export type SmithersUiStylesProps = {
  /**
   * Prepend the ui-styleguide theme token block (`workflowUiThemeCss`).
   * Gateway host pages already inline the theme, so workflow UIs leave this
   * off; standalone hosts (reports, marketing pages, plain HTML shells) turn
   * it on to get the light/dark tokens plus the base element styles.
   */
  withTheme?: boolean;
  /** Extra CSS appended after the component sheet (the consumer escape hatch). */
  extra?: string;
};

/** The composed stylesheet string for {@link SmithersUiStyles}. */
export function composeSmithersUiStyles({ withTheme = false, extra }: SmithersUiStylesProps = {}): string {
  const parts = withTheme ? [workflowUiThemeCss, smithersUiCss] : [smithersUiCss];
  if (extra) parts.push(extra);
  return parts.join("\n");
}

/**
 * Renders the component stylesheet in a `<style>` tag. Render once near the
 * root of a UI. Safe under `renderToStaticMarkup` (server-rendered docs and
 * tests), where effects never run and the injection fallback cannot help.
 */
export function SmithersUiStyles(props: SmithersUiStylesProps = {}) {
  // Literal attribute: JSX attribute names must be static, so this cannot use
  // SMITHERS_UI_STYLE_ATTR — keep the two in sync (useInjectUiCss dedupes on it).
  return <style data-smithers-ui="">{composeSmithersUiStyles(props)}</style>;
}

/**
 * Browser fallback: idempotently append the component sheet to `<head>` if no
 * marker style element exists yet. Every component in this package calls this,
 * so a consumer who forgets `<SmithersUiStyles/>` still gets styled output.
 * No-ops during server rendering (insertion effects never run there).
 */
export function useInjectUiCss(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)) return;
    const el = document.createElement("style");
    el.setAttribute(SMITHERS_UI_STYLE_ATTR, "");
    el.textContent = smithersUiCss;
    document.head.appendChild(el);
  }, []);
}

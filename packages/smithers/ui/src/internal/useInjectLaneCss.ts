import { useInsertionEffect } from "react";

/**
 * Idempotently append a lane-owned CSS fragment to <head>. Mirrors
 * useInjectUiCss but dedupes per fragment on data-smithers-ui-lane. After the
 * integration lane composes the fragment into smithersUiCss the extra style
 * element is redundant but harmless: the rules are identical.
 */
export function useInjectLaneCss(id: string, css: string): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[data-smithers-ui-lane="${id}"]`)) return;
    const el = document.createElement("style");
    el.setAttribute("data-smithers-ui-lane", id);
    el.textContent = css;
    document.head.appendChild(el);
  }, [id, css]);
}

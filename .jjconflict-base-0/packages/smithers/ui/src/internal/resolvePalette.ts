import { DEFAULT_THEME_KEY, themeRegistry } from "@smthrs/ui-styleguide";

export type ResolvedPalette = keyof typeof themeRegistry;

type PaletteRoot = Pick<HTMLElement, "getAttribute">;

function currentRoot(): PaletteRoot | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

/** Resolve `data-palette`, accepting only registered palette keys. */
export function resolvePalette(root: PaletteRoot | null = currentRoot()): ResolvedPalette {
  const explicit = root?.getAttribute("data-palette");
  return explicit && Object.prototype.hasOwnProperty.call(themeRegistry, explicit)
    ? (explicit as ResolvedPalette)
    : DEFAULT_THEME_KEY;
}

/** Subscribe to palette changes on the document root. */
export function subscribePalette(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette"] });
  return () => observer.disconnect();
}

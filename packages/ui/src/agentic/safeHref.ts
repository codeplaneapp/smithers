/**
 * Allow only navigable schemes onto a rendered href. Scheme-less relative and
 * anchor links pass through unchanged.
 */
export function safeHref(raw: string): string | undefined {
  const href = raw.trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    if (proto !== "http" && proto !== "https" && proto !== "mailto") return undefined;
  }
  return href;
}

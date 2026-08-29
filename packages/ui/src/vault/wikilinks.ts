/**
 * Pure wikilink/frontmatter helpers for the vault lane, ported faithfully
 * from the ddd VaultTab implementation in the Smithers 0.x workflow UI pack.
 *
 * Deliberately free of React so tests (and any other consumer) can import the
 * link logic without pulling a browser-shaped dependency tree.
 */

/** Href prefix for a wikilink rendered into markdown. Scheme-less on purpose:
 *  href sanitizers drop unknown schemes, which would swallow the click. */
export const NOTE_HREF = "#note/";

export function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: source };
  return { frontmatter: match[1] ?? "", body: source.slice(match[0].length) };
}

export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  return `---\n${frontmatter}\n---\n${body}`;
}

/**
 * Some markdown serializers escape literal square brackets, turning
 * `[[Note]]` into `\[\[Note]]` and severing the vault's link graph on save.
 * Every edit is run through this before it becomes file content.
 */
export function restoreWikilinks(markdown: string): string {
  return markdown.replaceAll("\\[\\[", "[[").replaceAll("\\]\\]", "]]");
}

export function noteHref(path: string): string {
  return `${NOTE_HREF}${encodeURIComponent(path)}`;
}

/** Decode a click href back to a vault path, or "" when it is not a wikilink. */
export function pathFromHref(href: string): string {
  if (!href.startsWith(NOTE_HREF)) return "";
  try {
    return decodeURIComponent(href.slice(NOTE_HREF.length));
  } catch {
    return "";
  }
}

export function noteLabel(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/**
 * Rewrite `[[wikilinks]]` into markdown links the shared `Markdown` primitive
 * renders, so clicking one navigates in-app. Links inside fenced or inline code
 * are left alone — Obsidian does not resolve those either. An unresolved link
 * degrades to its plain label rather than a dead anchor.
 */
export function wikilinksToMarkdown(body: string, resolve: (target: string) => string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // Split on inline code so a `[[link]]` inside backticks stays literal.
      return line
        .split(/(`[^`]*`)/)
        .map((segment) => {
          if (segment.startsWith("`")) return segment;
          return segment.replace(/!?\[\[([^\]\n]+)\]\]/g, (_raw, inner: string) => {
            const [beforeAlias = "", ...aliasParts] = inner.split("|");
            const [target = "", ...headingParts] = beforeAlias.split("#");
            const heading = headingParts.join("#").trim();
            const alias = aliasParts.join("|").trim();
            const label = alias || (target.trim() ? beforeAlias.trim() : `#${heading}`);
            const path = target.trim() ? resolve(target.trim()) : "";
            if (!path) return label;
            return `[${label}](${noteHref(path)})`;
          });
        })
        .join("");
    })
    .join("\n");
}

/** One parsed `[[wikilink]]` occurrence. */
export type Wikilink = {
  /** Link target note name/path (the part before any `#heading` or `|alias`). */
  target: string;
  /** Heading within the target (text after `#`, trimmed); "" when none. */
  heading: string;
  /** Display alias (text after `|`, trimmed); "" when none. */
  alias: string;
  /** True for `![[embeds]]`. */
  embed: boolean;
  /** The full matched source, e.g. `![[Note#Heading|Alias]]`. */
  raw: string;
};

/**
 * Extract every `[[wikilink]]` from markdown, with the same fence/inline-code
 * safety as {@link wikilinksToMarkdown}: occurrences inside fenced or inline
 * code are not links (Obsidian does not resolve those either).
 */
export function parseWikilinks(markdown: string): Wikilink[] {
  const links: Wikilink[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Split on inline code so a `[[link]]` inside backticks stays literal.
    for (const segment of line.split(/(`[^`]*`)/)) {
      if (segment.startsWith("`")) continue;
      for (const match of segment.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
        const inner = match[2] ?? "";
        const [beforeAlias = "", ...aliasParts] = inner.split("|");
        const [target = "", ...headingParts] = beforeAlias.split("#");
        links.push({
          target: target.trim(),
          heading: headingParts.join("#").trim(),
          alias: aliasParts.join("|").trim(),
          embed: match[1] === "!",
          raw: match[0],
        });
      }
    }
  }
  return links;
}

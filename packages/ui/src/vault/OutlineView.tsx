/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { cn } from "../cn";
import { useVaultCss } from "./useVaultCss";

/** One heading in a markdown document, 1-based line numbered. */
export type OutlineHeading = {
  /** ATX level, 1 (h1) through 6 (h6). */
  depth: number;
  /** Heading text with any trailing `#`s stripped. */
  text: string;
  /** 1-based source line, for scroll-to-heading. */
  line: number;
};

/**
 * Parse markdown ATX headings into an outline. Fence-safe: `#` lines inside
 * fenced code blocks are not headings.
 */
export function parseOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  let inFence = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) {
      headings.push({ depth: match[1]!.length, text: match[2]!, line: i + 1 });
    }
  }
  return headings;
}

export type OutlineViewProps = {
  /** Markdown source to outline. */
  markdown: string;
  /** Click handler receiving the heading's 1-based source line. */
  onHeadingClick?: (line: number) => void;
  className?: string;
  style?: CSSProperties;
  /** Copy shown when the document has no headings. */
  emptyLabel?: string;
};

/** The Obsidian outline pane: an indented, clickable heading tree. */
export function OutlineView({
  markdown,
  onHeadingClick,
  className,
  style,
  emptyLabel = "No headings",
}: OutlineViewProps) {
  useVaultCss();
  const headings = parseOutline(markdown);
  return (
    <div
      data-slot="vault-outline"
      role="tree"
      aria-label="Document outline"
      className={cn("sui-vault-outline", className)}
      style={style}
    >
      {headings.length === 0 ? <p className="sui-vault-outline-empty">{emptyLabel}</p> : null}
      {headings.map((heading) => (
        <button
          key={`${heading.line}:${heading.text}`}
          type="button"
          role="treeitem"
          aria-level={heading.depth}
          data-depth={heading.depth}
          className="sui-vault-outline-item"
          style={{ paddingLeft: 8 + (heading.depth - 1) * 14 }}
          onClick={() => onHeadingClick?.(heading.line)}
        >
          {heading.text}
        </button>
      ))}
    </div>
  );
}

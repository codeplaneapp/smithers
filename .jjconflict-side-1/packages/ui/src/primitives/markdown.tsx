/** @jsxImportSource react */
import { type ComponentProps, Fragment, memo, type MouseEvent, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

/**
 * Inline tokens, in match priority order: `code`, **bold**, *italic*, and
 * [links](href). Bold is matched before italic so `**x**` isn't eaten by the
 * single-asterisk rule; code is matched first so `*` inside a span stays
 * literal. Links start with `[`, so they never collide with the other rules.
 */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

/** Handler invoked when a rendered link is activated. */
export type MarkdownLinkClick = (href: string, event: MouseEvent<HTMLAnchorElement>) => void;

/**
 * Allow only navigable schemes onto a rendered `href`. A `javascript:` or
 * `data:` URL from model output would otherwise be a live XSS vector on click;
 * anything scheme-bearing outside the allowlist is dropped (the anchor renders
 * with no `href`), while scheme-less relative/anchor links pass through.
 */
export function safeMarkdownHref(raw: string): string | undefined {
  const href = raw.trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (scheme) {
    const proto = scheme[1]!.toLowerCase();
    if (proto !== "http" && proto !== "https" && proto !== "mailto") return undefined;
  }
  return href;
}

/**
 * Everything renders through React children (never `innerHTML`), so model
 * output can't inject markup -- this lightweight renderer is XSS-safe by
 * construction, and link hrefs are additionally scheme-filtered.
 */
function renderInline(text: string, keyPrefix: string, onLinkClick?: MarkdownLinkClick): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      out.push(text.slice(last, idx));
    }
    const token = match[0];
    const key = `${keyPrefix}.${i++}`;
    if (token.startsWith("`")) {
      out.push(
        <code className="sui-md-inline-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const link = LINK.exec(token)!;
      const label = link[1]!;
      const href = safeMarkdownHref(link[2]!);
      out.push(
        <a
          className="sui-md-link"
          key={key}
          href={href}
          onClick={
            onLinkClick
              ? (event) => {
                  event.preventDefault();
                  if (href !== undefined) onLinkClick(href, event);
                }
              : undefined
          }
        >
          {label}
        </a>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = idx + token.length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

const isBullet = (line: string) => /^\s*[-*]\s+/.test(line);
const isOrdered = (line: string) => /^\s*\d+\.\s+/.test(line);
const isFence = (line: string) => line.trimStart().startsWith("```");
const isHeading = (line: string) => /^#{1,6}\s+/.test(line);

/** Parse the source into block-level React nodes. */
function renderBlocks(content: string, onLinkClick?: MarkdownLinkClick): ReactNode[] {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (isFence(line)) {
      const info = line.trimStart().slice(3).trim();
      const language = info ? info.split(/\s+/, 1)[0]!.toLowerCase() : undefined;
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1; // consume the closing fence (or run off the end)
      blocks.push(<CodeBlock code={code.join("\n")} language={language} key={key++} />);
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        <div className={`sui-md-heading sui-md-h${level}`} key={key++}>
          {renderInline(heading[2]!, `h${key}`, onLinkClick)}
        </div>,
      );
      i += 1;
      continue;
    }

    if (isBullet(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isBullet(lines[i]!)) {
        const text = lines[i]!.replace(/^\s*[-*]\s+/, "");
        items.push(<li key={items.length}>{renderInline(text, `ul${key}.${items.length}`, onLinkClick)}</li>);
        i += 1;
      }
      blocks.push(
        <ul className="sui-md-list" key={key++}>
          {items}
        </ul>,
      );
      continue;
    }

    if (isOrdered(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isOrdered(lines[i]!)) {
        const text = lines[i]!.replace(/^\s*\d+\.\s+/, "");
        items.push(<li key={items.length}>{renderInline(text, `ol${key}.${items.length}`, onLinkClick)}</li>);
        i += 1;
      }
      blocks.push(
        <ol className="sui-md-list" key={key++}>
          {items}
        </ol>,
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !isFence(lines[i]!) &&
      !isHeading(lines[i]!) &&
      !isBullet(lines[i]!) &&
      !isOrdered(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push(
      <p className="sui-md-p" key={key++}>
        {para.map((text, idx) => (
          <Fragment key={idx}>
            {idx > 0 ? <br /> : null}
            {renderInline(text, `p${key}.${idx}`, onLinkClick)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}

export type MarkdownProps = Omit<ComponentProps<"div">, "children" | "onClick"> & {
  /** The Markdown source string to render. */
  content: string;
  /**
   * Intercept link activation instead of navigating. Receives the (scheme-safe)
   * href and the click event, with `preventDefault()` already called.
   */
  onLinkClick?: MarkdownLinkClick;
};

/**
 * A small, dependency-free Markdown renderer covering what a chat model
 * actually emits: fenced code blocks, headings, ordered/unordered lists, inline
 * code, bold, italics, and links. Anything else falls through as plain
 * paragraphs.
 *
 * Wrapped in `React.memo`, so a streaming transcript only re-parses the source
 * whose `content` actually changed -- the default shallow prop comparison keeps
 * a stable `content` string (and `onLinkClick`) from re-rendering.
 */
function MarkdownImpl({ content, onLinkClick, className, ...props }: MarkdownProps) {
  useInjectUiCss();
  return (
    <div data-slot="markdown" className={cn("sui-md", className)} {...props}>
      {renderBlocks(content, onLinkClick)}
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);

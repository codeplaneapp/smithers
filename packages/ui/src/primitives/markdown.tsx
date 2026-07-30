/** @jsxImportSource react */
import { type ComponentProps, Fragment, memo, type MouseEvent, type ReactNode, useMemo } from "react";
import { CodeBlock } from "./CodeBlock";
import { cn } from "../cn";
import { safeHref } from "../agentic/safeHref";
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

/** @deprecated Use `safeHref` from `agentic/safeHref` instead. */
export { safeHref as safeMarkdownHref } from "../agentic/safeHref";

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
      const href = safeHref(link[2]!);
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

/**
 * Split at the same boundaries as `renderBlocks`. The final block may still
 * grow while content streams; every earlier block is stable.
 */
function splitBlockSources(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trim() === "") {
      i += 1;
      continue;
    }

    const start = i;
    if (isFence(lines[i]!)) {
      i += 1;
      while (i < lines.length && !isFence(lines[i]!)) i += 1;
      if (i < lines.length) i += 1;
    } else if (isHeading(lines[i]!)) {
      i += 1;
    } else if (isBullet(lines[i]!)) {
      while (i < lines.length && isBullet(lines[i]!)) i += 1;
    } else if (isOrdered(lines[i]!)) {
      while (i < lines.length && isOrdered(lines[i]!)) i += 1;
    } else {
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !isFence(lines[i]!) &&
        !isHeading(lines[i]!) &&
        !isBullet(lines[i]!) &&
        !isOrdered(lines[i]!)
      ) {
        i += 1;
      }
    }
    blocks.push(lines.slice(start, i).join("\n"));
  }

  return blocks;
}

/** @internal Exposed so parser reuse can be verified without mocking Markdown output. */
export const markdownBlockParser = { render: renderBlocks };

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
 * Wrapped in `React.memo`, with completed blocks cached by source so streaming
 * updates only re-parse the trailing block.
 */
function MarkdownImpl({ content, onLinkClick, className, ...props }: MarkdownProps) {
  useInjectUiCss();
  const completedBlocks = useMemo(() => new Map<string, ReactNode[]>(), [onLinkClick]);
  const sources = splitBlockSources(content);
  const rendered = sources.map((source, index) => {
    if (index === sources.length - 1) return markdownBlockParser.render(source, onLinkClick);

    let block = completedBlocks.get(source);
    if (!block) {
      block = markdownBlockParser.render(source, onLinkClick);
      completedBlocks.set(source, block);
    }
    return block;
  });

  return (
    <div data-slot="markdown" className={cn("sui-md", className)} {...props}>
      {rendered}
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);

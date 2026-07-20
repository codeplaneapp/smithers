import { Fragment, memo, type ReactNode } from "react";

// Inline tokens: `code`, **bold**, *italic*. Order matters — bold is matched
// before italic so `**x**` doesn't get eaten by the single-asterisk rule.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;

// Everything renders through React children (never innerHTML), so model output
// can't inject markup — this lightweight renderer is XSS-safe by construction.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
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
        <code className="md-inline-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
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

/**
 * A small, dependency-free Markdown renderer covering what a chat model
 * actually emits: fenced code blocks, headings, ordered/unordered lists, inline
 * code, bold, and italics. Anything else falls through as plain paragraphs.
 *
 * Wrapped in React.memo so a streaming transcript only re-parses the bubble
 * whose `content` actually changed. The sole prop is a primitive string, so the
 * default shallow comparison is an exact equality check.
 */
function MarkdownImpl({ content }: { content: string }): ReactNode {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (or run off the end)
      blocks.push(
        <pre className="md-code-block" key={key++}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <div className={`md-heading md-h${level}`} key={key++}>
          {renderInline(heading[2], `h${key}`)}
        </div>,
      );
      i += 1;
      continue;
    }

    if (isBullet(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isBullet(lines[i])) {
        const text = lines[i].replace(/^\s*[-*]\s+/, "");
        items.push(<li key={items.length}>{renderInline(text, `ul${key}.${items.length}`)}</li>);
        i += 1;
      }
      blocks.push(
        <ul className="md-list" key={key++}>
          {items}
        </ul>,
      );
      continue;
    }

    if (isOrdered(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isOrdered(lines[i])) {
        const text = lines[i].replace(/^\s*\d+\.\s+/, "");
        items.push(<li key={items.length}>{renderInline(text, `ol${key}.${items.length}`)}</li>);
        i += 1;
      }
      blocks.push(
        <ol className="md-list" key={key++}>
          {items}
        </ol>,
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isBullet(lines[i]) &&
      !isOrdered(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p className="md-p" key={key++}>
        {para.map((text, idx) => (
          <Fragment key={idx}>
            {idx > 0 ? <br /> : null}
            {renderInline(text, `p${key}.${idx}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <>{blocks}</>;
}

export const Markdown = memo(MarkdownImpl) as (props: {
  content: string;
}) => ReactNode;

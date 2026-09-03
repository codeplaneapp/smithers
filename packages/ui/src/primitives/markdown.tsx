/** @jsxImportSource react */
import { type ComponentProps, Fragment, memo, type MouseEvent, type ReactNode, useMemo } from "react";
import { CodeBlock } from "./CodeBlock";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table";
import { cn } from "../cn";
import { safeHref } from "../internal/safeHref";
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

/*
 * GitHub-flavored tables.
 *
 * A table is one of the shapes a model reaches for most — "which repos, how
 * many issues" is a table — and without a rule here every `|` and every
 * `---|---` lands on screen as literal text inside one paragraph
 * (LIBRARY-CHANGE-REQUESTS §5). The shape is a header row, a delimiter row
 * whose column count matches it, then rows until a line that is not a row.
 */

/** A line that could be a table row: it has a pipe and is not a fence. */
const isRow = (line: string) => line.includes("|") && !isFence(line);

/** `---`, `:--`, `--:`, or `:-:`, which is the delimiter row's whole grammar. */
const isDelimiter = (cell: string) => /^:?-+:?$/.test(cell.trim());

/** Split one row into cells, dropping the optional leading and trailing pipes. */
const rowCells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};

/** The per-column alignment the delimiter row declares. */
type Alignment = "left" | "center" | "right";

const alignmentOf = (cell: string): Alignment => {
  const text = cell.trim();
  if (text.startsWith(":") && text.endsWith(":")) return "center";
  if (text.endsWith(":")) return "right";
  return "left";
};

/**
 * Whether a table starts at `index`, and how wide it is.
 *
 * A header row alone is a paragraph; it is the matching delimiter row that
 * makes it a table, which is exactly the rule that keeps a sentence containing
 * a pipe from becoming one.
 */
const tableAt = (lines: ReadonlyArray<string>, index: number): number | undefined => {
  const header = lines[index]
  const delimiter = lines[index + 1]
  if (header === undefined || delimiter === undefined) return undefined;
  if (!isRow(header) || !isRow(delimiter)) return undefined;
  const cells = rowCells(delimiter);
  if (cells.length === 0 || !cells.every(isDelimiter)) return undefined;
  return rowCells(header).length === cells.length ? cells.length : undefined;
};

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

    const columns = tableAt(lines, i);
    if (columns !== undefined) {
      const alignments = rowCells(lines[i + 1]!).map(alignmentOf);
      const header = rowCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i]!) && lines[i]!.trim() !== "") {
        rows.push(rowCells(lines[i]!));
        i += 1;
      }
      blocks.push(
        <Table className="sui-md-table" key={key++}>
          <TableHeader>
            <TableRow>
              {header.map((cell, column) => (
                <TableHead key={column} style={{ textAlign: alignments[column] ?? "left" }}>
                  {renderInline(cell, `th${key}.${column}`, onLinkClick)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((cells, row) => (
              <TableRow key={row}>
                {/*
                  A ragged row is the source's, not a reason to drop it: every
                  declared column is rendered and a missing cell is empty.
                */}
                {Array.from({ length: columns }, (_unused, column) => (
                  <TableCell key={column} style={{ textAlign: alignments[column] ?? "left" }}>
                    {renderInline(cells[column] ?? "", `td${key}.${row}.${column}`, onLinkClick)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>,
      );
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
      !isOrdered(lines[i]!) &&
      tableAt(lines, i) === undefined
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
    } else if (tableAt(lines, i) !== undefined) {
      i += 2;
      while (i < lines.length && isRow(lines[i]!) && lines[i]!.trim() !== "") i += 1;
    } else {
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !isFence(lines[i]!) &&
        !isHeading(lines[i]!) &&
        !isBullet(lines[i]!) &&
        !isOrdered(lines[i]!) &&
        tableAt(lines, i) === undefined
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

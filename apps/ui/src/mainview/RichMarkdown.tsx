import { Markdown, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"

/*
 * Markdown with tables.
 *
 * `@smthrs/ui`'s renderer handles fences, headings, lists and inline spans and
 * has no table rule, so a model that answers with a table rendered as raw pipe
 * text in the transcript (§4.2) — every `|` and every `---|---` on screen. The
 * library is the right home for the rule; until it lands, the host splits the
 * table blocks out and renders them with the library's own table primitives,
 * and hands everything else to the library unchanged. See
 * LIBRARY-CHANGE-REQUESTS.md.
 */

/** One cell row, without the leading/trailing pipes GFM allows. */
const cells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

/** `---`, `:--`, `--:`, `:-:`, one per column. */
const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

const isRow = (line: string): boolean => line.includes("|") && line.trim() !== ""

const alignmentOf = (cell: string): "left" | "center" | "right" => {
  const left = cell.startsWith(":")
  const right = cell.endsWith(":")
  if (left && right) return "center"
  return right ? "right" : "left"
}

interface TableBlock {
  readonly kind: "table"
  readonly header: ReadonlyArray<string>
  readonly align: ReadonlyArray<"left" | "center" | "right">
  readonly rows: ReadonlyArray<ReadonlyArray<string>>
}

type Segment = { readonly kind: "markdown"; readonly text: string } | TableBlock

/**
 * Splits `content` into table blocks and everything else.
 *
 * Fenced code is copied through untouched: a pipe inside a fence is data, and
 * a table that swallowed it would rewrite what the model actually said.
 */
export const segments = (content: string): ReadonlyArray<Segment> => {
  const lines = content.split("\n")
  const out: Segment[] = []
  let plain: string[] = []
  const flush = (): void => {
    if (plain.length > 0) out.push({ kind: "markdown", text: plain.join("\n") })
    plain = []
  }
  let index = 0
  let inFence = false
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line.trimStart().startsWith("```")) inFence = !inFence
    const delimiter = lines[index + 1]
    if (
      !inFence &&
      isRow(line) &&
      delimiter !== undefined &&
      DELIMITER.test(delimiter) &&
      cells(delimiter).length === cells(line).length &&
      cells(line).length > 1
    ) {
      flush()
      const header = cells(line)
      const align = cells(delimiter).map(alignmentOf)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && isRow(lines[index] ?? "")) {
        const row = cells(lines[index] ?? "")
        // A short or long row is still the author's row: pad, never drop.
        rows.push(header.map((_column, position) => row[position] ?? ""))
        index += 1
      }
      out.push({ kind: "table", header, align, rows })
      continue
    }
    plain.push(line)
    index += 1
  }
  flush()
  return out
}

/** Markdown for the transcript and the cards: the library's, plus tables. */
export function RichMarkdown({
  content,
  className
}: {
  readonly content: string
  readonly className?: string
}) {
  const parts = segments(content)
  if (parts.every((part) => part.kind === "markdown")) {
    return <Markdown className={className} content={content} />
  }
  return (
    <div className={className}>
      {parts.map((part, position) =>
        part.kind === "markdown" ?
          (
            part.text.trim() === "" ? null : <Markdown key={`md-${position}`} content={part.text} />
          ) :
          (
            <div className="md-table-scroller" key={`table-${position}`}>
              <Table>
                <TableHeader>
                  <TableRow>
                    {part.header.map((cell, column) => (
                      <TableHead key={`h-${column}`} style={{ textAlign: part.align[column] ?? "left" }}>
                        {cell}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {part.rows.map((row, rowIndex) => (
                    <TableRow key={`r-${rowIndex}`}>
                      {row.map((cell, column) => (
                        <TableCell key={`c-${column}`} style={{ textAlign: part.align[column] ?? "left" }}>
                          {cell}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
      )}
    </div>
  )
}

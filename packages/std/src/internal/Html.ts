/**
 * Small, dependency-free HTML renderers for web retrieval.
 *
 * @since 0.1.0
 */

const skipped = /<(head|script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const comments = /<!--[\s\S]*?-->/g
const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

const decode = (value: string): string =>
  value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const number = Number.parseInt(
        entity.slice(entity[1]?.toLowerCase() === "x" ? 2 : 1),
        entity[1]?.toLowerCase() === "x" ? 16 : 10
      )
      return Number.isFinite(number) ? String.fromCodePoint(number) : match
    }
    return entities[entity.toLowerCase()] ?? match
  })

const source = (html: string): string => html.replace(comments, "").replace(skipped, "")

/**
 * Extracts readable text while dropping executable and presentation-only elements.
 *
 * @category rendering
 * @since 0.1.0
 */
export const toText = (html: string): string =>
  decode(source(html).replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()

/**
 * Converts a conservative subset of HTML into readable Markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const toMarkdown = (html: string): string => {
  const markdown = source(html)
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_all, level: string, text: string) => `\n\n${"#".repeat(Number(level))} ${toText(text)}\n\n`
    )
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_all, href: string, text: string) => `[${toText(text)}](${href})`
    )
    .replace(/<li\b[^>]*>/gi, "\n- ").replace(
      /<\/?(ul|ol|p|div|section|article|main|blockquote|pre|tr)\b[^>]*>/gi,
      "\n"
    )
    .replace(/<br\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")
  return decode(markdown).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

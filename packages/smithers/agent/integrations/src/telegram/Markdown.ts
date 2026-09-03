/**
 * Standard markdown to Telegram MarkdownV2.
 *
 * Telegram rejects an entire message with a 400 "can't parse entities" for a
 * single unescaped reserved character, so everything outside a recognized
 * token is escaped defensively. Already-converted segments are stashed behind
 * NUL sentinels during the final escape pass and substituted back afterwards;
 * {@link clean} strips NUL from the input first, so user text can never
 * collide with a sentinel.
 *
 * Callers pair this with a plain-text fallback: see `TelegramClient`, which
 * resends unformatted when Telegram rejects the entities anyway.
 *
 * @since 1.0.0
 */

/** MarkdownV2 reserved characters, which must be escaped in plain text. */
const RESERVED = /([_*[\]()~`>#+\-=|{}.!\\])/g

const NUL = String.fromCharCode(0)
const SENTINEL_SPLIT = new RegExp(`(${NUL}\\d+${NUL})`, "g")
const SENTINEL_MATCH = new RegExp(`^${NUL}\\d+${NUL}$`)
const SENTINEL_REPLACE = new RegExp(`${NUL}(\\d+)${NUL}`, "g")

/**
 * Strips NUL characters. They collide with the sentinel scheme, and Telegram
 * rejects them anyway.
 *
 * @category constructors
 * @since 1.0.0
 */
export const clean = (text: string | undefined | null): string =>
  text === undefined || text === null || text.length === 0 ? "" : text.split(NUL).join("")

/**
 * Escapes plain text for MarkdownV2.
 *
 * @category constructors
 * @since 1.0.0
 */
export const escape = (text: string): string => text.length === 0 ? "" : text.replace(RESERVED, "\\$1")

/** `>` is reserved, but meaningful at the start of a line, so it survives. */
const escapePreservingBlockquote = (text: string): string => {
  if (text.length === 0) return ""
  return text
    .split("\n")
    .map((line) => {
      const match = /^(>+\s?)(.*)$/.exec(line)
      return match === null ? escape(line) : `${match[1]}${escape(match[2] as string)}`
    })
    .join("\n")
}

/** Inside a code block Telegram requires backtick and backslash escaped. */
const escapeCode = (text: string): string => text.replace(/([`\\])/g, "\\$1")

/** Inside an inline-link URL only `)` and `\` need escaping. */
const escapeUrl = (url: string): string => url.replace(/([)\\])/g, "\\$1")

/**
 * Converts standard markdown to MarkdownV2.
 *
 * Handles fenced and inline code, links, bold (`**` to `*`), strikethrough
 * (`~~` to `~`), italic (`*` or `_` to `_`), and headings, which become bold
 * because an unescaped `#` is one of the characters Telegram rejects.
 *
 * @category constructors
 * @since 1.0.0
 */
export const toTelegram = (markdown: string): string => {
  const replacements: Array<string> = []
  const store = (formatted: string): string => {
    const sentinel = `${NUL}${replacements.length}${NUL}`
    replacements.push(formatted)
    return sentinel
  }
  let converted = clean(markdown)
  converted = converted.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_match, lang: string | undefined, code: string) => store(`\`\`\`${lang ?? ""}\n${escapeCode(code)}\`\`\``)
  )
  converted = converted.replace(/`([^`]+)`/g, (_match, code: string) => store(`\`${escapeCode(code)}\``))
  converted = converted.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, text: string, url: string) => store(`[${escape(text)}](${escapeUrl(url)})`)
  )
  converted = converted.replace(/\*\*([^*]+)\*\*/g, (_match, content: string) => store(`*${escape(content)}*`))
  converted = converted.replace(/~~([^~]+)~~/g, (_match, content: string) => store(`~${escape(content)}~`))
  converted = converted.replace(
    /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
    (_match, content: string) => store(`_${escape(content)}_`)
  )
  converted = converted.replace(/_([^_\n]+)_/g, (_match, content: string) => store(`_${escape(content)}_`))
  converted = converted.replace(
    /^(#{1,6})\s*(.*)$/gm,
    (_match, _hashes: string, heading: string) => store(`*${escape(heading.trim())}*`)
  )

  const escaped = converted
    .split(SENTINEL_SPLIT)
    .map((segment) => SENTINEL_MATCH.test(segment) ? segment : escapePreservingBlockquote(segment))
    .join("")

  // A stored segment can itself contain a sentinel, so substitute until the
  // text stops changing rather than assuming one pass is enough.
  let expanded = escaped
  for (let pass = 0; pass < replacements.length; pass += 1) {
    const next = expanded.replace(
      SENTINEL_REPLACE,
      (_match, index: string) => replacements[Number.parseInt(index, 10)] as string
    )
    if (next === expanded) break
    expanded = next
  }
  return expanded
}

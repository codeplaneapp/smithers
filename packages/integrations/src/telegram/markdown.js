// Telegram MarkdownV2 conversion/escaping, ported from the eliza
// plugin-telegram reference client (utils.ts): standard markdown in,
// Telegram-safe MarkdownV2 out. Telegram rejects the whole message with
// 400 "can't parse entities" on a single unescaped reserved character, so
// everything outside recognized tokens is escaped defensively; callers pair
// this with a plain-text fallback (see TelegramClient.sendMessageSmart).

// Telegram MarkdownV2 reserved characters that must be escaped in plain text.
const TELEGRAM_RESERVED_REGEX = /([_*[\]()~`>#+\-=|{}.!\\])/g;

// Sentinel scheme for convertMarkdownToTelegram: already-formatted segments
// are stashed and replaced with `\u0000<index>\u0000` so the final escape pass
// leaves them alone. cleanText() strips NULs from input first, so user text
// can never collide with a sentinel. SENTINEL_TEST is non-global (RegExp.test
// lastIndex is not involved) and split/replace with a global regex don't leak
// lastIndex state, so these are safe to share across calls.
const NULL_CHAR = String.fromCharCode(0);
const SENTINEL_PATTERN = new RegExp(`(${NULL_CHAR}\\d+${NULL_CHAR})`, "g");
const SENTINEL_TEST = new RegExp(`^${NULL_CHAR}\\d+${NULL_CHAR}$`);
const SENTINEL_REPLACE = new RegExp(`${NULL_CHAR}(\\d+)${NULL_CHAR}`, "g");

/**
 * Escape plain text for Telegram MarkdownV2 (every reserved character gets a
 * leading backslash).
 * @param {string} text
 * @returns {string}
 */
export function escapeMarkdownV2(text) {
  if (!text) {
    return "";
  }
  return text.replace(TELEGRAM_RESERVED_REGEX, "\\$1");
}

/**
 * Escape plain text line-by-line while preserving leading blockquote markers
 * (`>` is reserved in MarkdownV2 but meaningful at line start).
 * @param {string} text
 * @returns {string}
 */
function escapePlainTextPreservingBlockquote(text) {
  if (!text) {
    return "";
  }
  return text
    .split("\n")
    .map((line) => {
      const match = line.match(/^(>+\s?)(.*)$/);
      if (match) {
        return match[1] + escapeMarkdownV2(match[2]);
      }
      return escapeMarkdownV2(line);
    })
    .join("\n");
}

/**
 * Inside code blocks Telegram requires ` and \ to be escaped.
 * @param {string} text
 * @returns {string}
 */
function escapeCode(text) {
  if (!text) {
    return "";
  }
  return text.replace(/([`\\])/g, "\\$1");
}

/**
 * Inside inline-link URLs only ")" and "\" need escaping.
 * @param {string} url
 * @returns {string}
 */
function escapeUrl(url) {
  if (!url) {
    return "";
  }
  return url.replace(/([)\\])/g, "\\$1");
}

/**
 * Convert standard markdown to Telegram MarkdownV2: fenced/inline code,
 * links, bold (`**` → `*`), strikethrough (`~~` → `~`), italic (`*`/`_` →
 * `_`), and headers (`#...` → bold — unescaped `#` crashes Telegram), with
 * everything else escaped. Uses NUL sentinels to protect already-formatted
 * segments during the final escape pass, then substitutes them back.
 * @param {string} markdown
 * @returns {string}
 */
export function convertMarkdownToTelegram(markdown) {
  /** @type {string[]} */
  const replacements = [];
  /**
   * @param {string} formatted
   * @returns {string}
   */
  function storeReplacement(formatted) {
    const sentinel = `${NULL_CHAR}${replacements.length}${NULL_CHAR}`;
    replacements.push(formatted);
    return sentinel;
  }
  let converted = cleanText(markdown);
  // 1. Fenced code blocks (```lang\n...```)
  converted = converted.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang, code) =>
    storeReplacement(`\`\`\`${lang || ""}\n${escapeCode(code)}\`\`\``),
  );
  // 2. Inline code (`...`)
  converted = converted.replace(/`([^`]+)`/g, (_match, code) => storeReplacement(`\`${escapeCode(code)}\``));
  // 3. Links: [text](url)
  converted = converted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) =>
    storeReplacement(`[${escapeMarkdownV2(text)}](${escapeUrl(url)})`),
  );
  // 4. Bold: **text** → *text*
  converted = converted.replace(/\*\*([^*]+)\*\*/g, (_match, content) =>
    storeReplacement(`*${escapeMarkdownV2(content)}*`),
  );
  // 5. Strikethrough: ~~text~~ → ~text~
  converted = converted.replace(/~~([^~]+)~~/g, (_match, content) =>
    storeReplacement(`~${escapeMarkdownV2(content)}~`),
  );
  // 6. Italic: *text* / _text_ → _text_
  converted = converted.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_match, content) =>
    storeReplacement(`_${escapeMarkdownV2(content)}_`),
  );
  converted = converted.replace(/_([^_\n]+)_/g, (_match, content) =>
    storeReplacement(`_${escapeMarkdownV2(content)}_`),
  );
  // 7. Headers: "# Title" → bold "*Title*"
  converted = converted.replace(/^(#{1,6})\s*(.*)$/gm, (_match, _hashes, headerContent) =>
    storeReplacement(`*${escapeMarkdownV2(String(headerContent).trim())}*`),
  );
  const finalEscaped = converted
    .split(SENTINEL_PATTERN)
    .map((segment) => (SENTINEL_TEST.test(segment) ? segment : escapePlainTextPreservingBlockquote(segment)))
    .join("");
  let expanded = finalEscaped;
  for (let pass = 0; pass < replacements.length; pass += 1) {
    const next = expanded.replace(SENTINEL_REPLACE, (_, index) => replacements[Number.parseInt(index, 10)]);
    if (next === expanded) {
      break;
    }
    expanded = next;
  }
  return expanded;
}

/**
 * Strip NUL characters (they collide with the sentinel scheme above and
 * Telegram rejects them anyway).
 * @param {string | undefined | null} text
 * @returns {string}
 */
export function cleanText(text) {
  if (!text) {
    return "";
  }
  return text.split("\u0000").join("");
}

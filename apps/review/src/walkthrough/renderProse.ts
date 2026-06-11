import { escapeHtml } from "./escapeHtml";

function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

/**
 * Escape-first markdown subset for narrator prose: paragraphs, ### headings,
 * - lists, > blockquotes, ``` fences, and inline code, bold, and emphasis.
 * Input is HTML-escaped before any transformation, so narrator output cannot
 * inject markup into the page.
 */
export function renderProse(text: string): string {
  const out: string[] = [];
  const lines = escapeHtml(text).split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];
  let fence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length > 0) out.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushQuote = () => {
    if (quote.length > 0) out.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (fence !== null) {
      if (/^```/.test(line.trim())) {
        out.push(`<pre class="prose-code"><code>${fence.join("\n")}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      flushAll();
      fence = [];
      continue;
    }
    if (trimmed === "") {
      flushAll();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      list.push(trimmed.replace(/^[-*]\s+/, ""));
      continue;
    }
    if (/^&gt;\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      quote.push(trimmed.replace(/^&gt;\s?/, ""));
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }
  if (fence !== null) out.push(`<pre class="prose-code"><code>${fence.join("\n")}</code></pre>`);
  flushAll();
  return out.join("\n");
}

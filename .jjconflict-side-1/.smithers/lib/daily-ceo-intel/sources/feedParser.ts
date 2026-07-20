export type FeedEntry = {
  title: string;
  url: string;
  publishedAt: string | null;
  body: string;
  author: string | null;
};

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block: string, tagNames: string[]): string | null {
  for (const tag of tagNames) {
    const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
    if (match) return decodeEntities(match[1]);
  }
  return null;
}

function extractAtomLink(block: string): string | null {
  const linkTags = [...block.matchAll(/<link\b([^>]*)\/?>(?:[\s\S]*?<\/link>)?/gi)];
  if (linkTags.length === 0) return null;
  const withRel = (rel: string) =>
    linkTags.find((m) => new RegExp(`rel=["']${rel}["']`, "i").test(m[1]) && /href=["']([^"']+)["']/i.test(m[1]));
  const alternate = withRel("alternate") ?? linkTags[0];
  const hrefMatch = alternate[1].match(/href=["']([^"']+)["']/i);
  return hrefMatch ? hrefMatch[1] : null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Minimal, dependency-free RSS 2.0 / Atom item extractor: title, link, date, summary, author. */
export function parseFeedEntries(xml: string): FeedEntry[] {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = isAtom
    ? [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[0])
    : [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[0]);

  return blocks
    .map((block): FeedEntry | null => {
      const title = extractTag(block, ["title"]);
      const url = isAtom ? extractAtomLink(block) : extractTag(block, ["link"]);
      if (!title || !url) return null;
      const publishedAt = isAtom
        ? normalizeDate(extractTag(block, ["published", "updated"]))
        : normalizeDate(extractTag(block, ["pubDate", "dc:date"]));
      const body = extractTag(block, ["content:encoded", "content", "summary", "description"]) ?? "";
      const author = extractTag(block, ["author", "dc:creator"]);
      return { title, url, publishedAt, body: body.slice(0, 4000), author };
    })
    .filter((entry): entry is FeedEntry => entry !== null);
}

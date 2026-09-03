import { describe, expect, test } from "bun:test";
import {
  NOTE_HREF,
  joinFrontmatter,
  noteHref,
  noteLabel,
  parseWikilinks,
  pathFromHref,
  restoreWikilinks,
  splitFrontmatter,
  wikilinksToMarkdown,
} from "../src/vault/wikilinks";

describe("splitFrontmatter", () => {
  test("no frontmatter returns the source as body", () => {
    expect(splitFrontmatter("# Hello\nbody")).toEqual({ frontmatter: null, body: "# Hello\nbody" });
  });

  test("splits frontmatter from the body", () => {
    expect(splitFrontmatter("---\ntitle: Hi\n---\nbody text")).toEqual({
      frontmatter: "title: Hi",
      body: "body text",
    });
  });

  test("tolerates CRLF line endings", () => {
    expect(splitFrontmatter("---\r\ntitle: Hi\r\n---\r\nbody")).toEqual({
      frontmatter: "title: Hi",
      body: "body",
    });
  });

  test("keeps the blank line after the closing fence in the body", () => {
    expect(splitFrontmatter("---\na: 1\n---\n\nbody").body).toBe("\nbody");
  });

  test("empty frontmatter is an empty string, not null", () => {
    expect(splitFrontmatter("---\n\n---\nbody")).toEqual({ frontmatter: "", body: "body" });
  });

  test("a leading --- with no closing fence is not frontmatter", () => {
    expect(splitFrontmatter("---\nnot closed").frontmatter).toBeNull();
  });
});

describe("joinFrontmatter", () => {
  test("null frontmatter returns the body unchanged", () => {
    expect(joinFrontmatter(null, "body")).toBe("body");
  });

  test("round-trips split output byte-for-byte", () => {
    for (const source of [
      "---\ntitle: Hi\n---\nbody text",
      "---\na: 1\n---\n\nbody",
      "---\n\n---\nbody",
      "plain body, no frontmatter",
    ]) {
      const { frontmatter, body } = splitFrontmatter(source);
      expect(joinFrontmatter(frontmatter, body)).toBe(source);
    }
  });
});

describe("restoreWikilinks", () => {
  test("unescapes serializer-escaped brackets", () => {
    expect(restoreWikilinks("see \\[\\[Note]] and \\[\\[Other\\]\\]")).toBe("see [[Note]] and [[Other]]");
  });

  test("leaves ordinary brackets alone", () => {
    expect(restoreWikilinks("[markdown](link) [[Note]]")).toBe("[markdown](link) [[Note]]");
  });
});

describe("noteHref / pathFromHref", () => {
  test("round-trips paths with spaces and folders", () => {
    const path = "Areas/My Note.md";
    const href = noteHref(path);
    expect(href.startsWith(NOTE_HREF)).toBe(true);
    expect(href).toContain(encodeURIComponent(path));
    expect(pathFromHref(href)).toBe(path);
  });

  test("rejects non-note hrefs", () => {
    expect(pathFromHref("https://example.com")).toBe("");
    expect(pathFromHref("#other/Area.md")).toBe("");
  });

  test("rejects malformed percent-encoding instead of throwing", () => {
    expect(pathFromHref(`${NOTE_HREF}%E0%A4%A`)).toBe("");
  });
});

describe("noteLabel", () => {
  test("strips folders and the .md extension", () => {
    expect(noteLabel("Areas/Marketing.md")).toBe("Marketing");
    expect(noteLabel("Marketing.md")).toBe("Marketing");
    expect(noteLabel("Marketing")).toBe("Marketing");
  });
});

describe("wikilinksToMarkdown", () => {
  const resolve = (target: string) => (target === "Missing" ? "" : `${target}.md`);

  test("rewrites a plain link", () => {
    expect(wikilinksToMarkdown("see [[Note]]", resolve)).toBe(`see [Note](#note/${encodeURIComponent("Note.md")})`);
  });

  test("prefers the alias as label", () => {
    expect(wikilinksToMarkdown("[[Note|Alias]]", resolve)).toBe(`[Alias](#note/${encodeURIComponent("Note.md")})`);
  });

  test("keeps the heading in the label when no alias", () => {
    expect(wikilinksToMarkdown("[[Note#Section]]", resolve)).toBe(
      `[Note#Section](#note/${encodeURIComponent("Note.md")})`,
    );
  });

  test("a heading-only link degrades to a #label with no anchor", () => {
    expect(wikilinksToMarkdown("[[#Section]]", resolve)).toBe("#Section");
  });

  test("an unresolved link degrades to its plain label", () => {
    expect(wikilinksToMarkdown("[[Missing]]", resolve)).toBe("Missing");
    expect(wikilinksToMarkdown("[[Missing|Alias]]", resolve)).toBe("Alias");
  });

  test("embeds rewrite like links", () => {
    expect(wikilinksToMarkdown("![[Image]]", resolve)).toBe(`[Image](#note/${encodeURIComponent("Image.md")})`);
  });

  test("aliases containing pipes join back together", () => {
    expect(wikilinksToMarkdown("[[Note|a|b]]", resolve)).toBe(`[a|b](#note/${encodeURIComponent("Note.md")})`);
  });

  test("links inside fenced code stay literal", () => {
    const body = "```\n[[Note]]\n```\n[[Note]]";
    expect(wikilinksToMarkdown(body, resolve)).toBe(
      "```\n[[Note]]\n```\n" + `[Note](#note/${encodeURIComponent("Note.md")})`,
    );
  });

  test("tilde fences count as fences", () => {
    expect(wikilinksToMarkdown("~~~\n[[Note]]\n~~~", resolve)).toBe("~~~\n[[Note]]\n~~~");
  });

  test("links inside inline code stay literal", () => {
    expect(wikilinksToMarkdown("`[[Note]]` and [[Note]]", resolve)).toBe(
      "`[[Note]]` and " + `[Note](#note/${encodeURIComponent("Note.md")})`,
    );
  });
});

describe("parseWikilinks", () => {
  test("extracts target, heading, alias, and embed flag", () => {
    expect(parseWikilinks("[[Note#Section|Alias]]")).toEqual([
      { target: "Note", heading: "Section", alias: "Alias", embed: false, raw: "[[Note#Section|Alias]]" },
    ]);
    expect(parseWikilinks("![[Image.png]]")).toEqual([
      { target: "Image.png", heading: "", alias: "", embed: true, raw: "![[Image.png]]" },
    ]);
  });

  test("finds multiple links across lines", () => {
    const links = parseWikilinks("[[A]]\nsome text [[B|Bee]] and [[C#See]]");
    expect(links.map((l) => l.target)).toEqual(["A", "B", "C"]);
    expect(links[1]!.alias).toBe("Bee");
    expect(links[2]!.heading).toBe("See");
  });

  test("skips fenced code and inline code", () => {
    const body = "```\n[[Fenced]]\n```\n`[[Inline]]`\n[[Real]]";
    expect(parseWikilinks(body).map((l) => l.target)).toEqual(["Real"]);
  });

  test("heading-only links have an empty target", () => {
    expect(parseWikilinks("[[#Local]]")[0]).toMatchObject({ target: "", heading: "Local" });
  });
});

import { describe, expect, test } from "bun:test";
import { parseWikilinks, wikilinksToMarkdown } from "../src/vault/wikilinks";

/**
 * Both wikilink functions promise the same thing in their JSDoc: fenced and
 * inline code are left alone, matching Obsidian. Both used to carry their own
 * copy of a scanner that could not see a multi-backtick code span and closed a
 * ``` fence on a `~~~` line. They now share one CommonMark-aware scanner, so
 * every case below is asserted against BOTH.
 */
const resolve = (target: string) => `notes/${target}.md`;

/** Assert the two functions agree: rewritten iff a link was parsed. */
function linkCount(markdown: string): { parsed: number; rewritten: number } {
  const rendered = wikilinksToMarkdown(markdown, resolve);
  return {
    parsed: parseWikilinks(markdown).length,
    rewritten: (rendered.match(/\]\(#note\//g) ?? []).length,
  };
}

describe("inline code spans of any backtick width are literal", () => {
  test("a single-backtick span keeps its wikilink literal", () => {
    expect(linkCount("see `[[Note]]` here")).toEqual({ parsed: 0, rewritten: 0 });
  });

  test("a double-backtick span keeps its wikilink literal", () => {
    // The bug: the old `/(`[^`]*`)/` split produced ["", "``", "[[Note]]", ...],
    // and the middle segment did not start with a backtick, so the link inside
    // a perfectly valid code span became a live note link.
    expect(linkCount("see ``[[Note]]`` here")).toEqual({ parsed: 0, rewritten: 0 });
  });

  test("a triple-backtick inline span keeps its wikilink literal", () => {
    expect(linkCount("see ```[[Note]]``` here")).toEqual({ parsed: 0, rewritten: 0 });
  });

  test("a span opened with two backticks is not closed by one", () => {
    expect(linkCount("``a ` b [[Note]]`` tail")).toEqual({ parsed: 0, rewritten: 0 });
  });

  test("an unterminated backtick run is literal text, so the link still resolves", () => {
    expect(linkCount("stray ` and [[Note]]")).toEqual({ parsed: 1, rewritten: 1 });
  });

  test("prose around a code span is still rewritten", () => {
    expect(wikilinksToMarkdown("`code` then [[Note]]", resolve)).toBe("`code` then [Note](#note/notes%2FNote.md)");
  });
});

describe("fences close only on their own marker", () => {
  test("a tilde line inside a backtick fence does not end it", () => {
    const markdown = ["```", "~~~", "[[Note]]", "```", "[[After]]"].join("\n");
    expect(linkCount(markdown)).toEqual({ parsed: 1, rewritten: 1 });
    expect(parseWikilinks(markdown)[0]?.target).toBe("After");
  });

  test("a backtick line inside a tilde fence does not end it", () => {
    const markdown = ["~~~", "```", "[[Note]]", "~~~", "[[After]]"].join("\n");
    expect(linkCount(markdown)).toEqual({ parsed: 1, rewritten: 1 });
  });

  test("a closing fence may be longer than the opener but not shorter", () => {
    const closedLong = ["```", "[[Inside]]", "````", "[[After]]"].join("\n");
    expect(linkCount(closedLong)).toEqual({ parsed: 1, rewritten: 1 });

    const notClosed = ["````", "[[Inside]]", "```", "[[After]]"].join("\n");
    expect(linkCount(notClosed)).toEqual({ parsed: 0, rewritten: 0 });
  });

  test("an info string keeps a fence open and is not a closer", () => {
    const markdown = ["```ts", "[[Inside]]", "```", "[[After]]"].join("\n");
    expect(linkCount(markdown)).toEqual({ parsed: 1, rewritten: 1 });
  });

  test("an unterminated fence runs to the end of the document", () => {
    const markdown = ["intro [[Before]]", "```", "[[Inside]]", "[[Also inside]]"].join("\n");
    expect(linkCount(markdown)).toEqual({ parsed: 1, rewritten: 1 });
    expect(parseWikilinks(markdown)[0]?.target).toBe("Before");
  });

  test("an indented fence still opens and closes a block", () => {
    const markdown = ["  ```", "  [[Inside]]", "  ```", "[[After]]"].join("\n");
    expect(linkCount(markdown)).toEqual({ parsed: 1, rewritten: 1 });
  });
});

describe("the rewrite preserves everything it does not touch", () => {
  test("code content survives byte for byte", () => {
    const markdown = ["```md", "  [[Note]]  ", "```", "``[[Other]]``"].join("\n");
    expect(wikilinksToMarkdown(markdown, resolve)).toBe(markdown);
  });

  test("an unresolved link degrades to its label in prose", () => {
    expect(wikilinksToMarkdown("[[Missing|Alias]]", () => "")).toBe("Alias");
  });
});

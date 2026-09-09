import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gateEvent } from "../action/src/gateEvent.ts";
import { parseReviewArgs } from "../src/cli/parseReviewArgs.ts";

/**
 * The package overview and contributor guide must describe rc.0.
 *
 * README.md and CONTRIBUTING.md drifted once already: CONTRIBUTING kept
 * documenting the 0.x agent engine, a Codex or Claude Code subprocess selected
 * by `SMITHERS_REVIEW_ENGINE`, for a release that runs no subprocess at all,
 * and README already said the opposite.
 *
 * The check is a name check, not a prose check. Every name below belongs to a
 * mechanism rc.0 deleted, so a document that mentions one is describing
 * something no code reads.
 */

const documents = ["../README.md", "../CONTRIBUTING.md"] as const;

/** Environment variables the 0.x agent engine read and rc.0 does not. */
const removedVariables = [
  "SMITHERS_REVIEW_ENGINE",
  "SMITHERS_REVIEW_MODEL",
  "SMITHERS_REVIEW_CHEAP_MODEL",
  "SMITHERS_REVIEW_FALLBACK_MODEL",
] as const;

/** The CLI agent rc.0 no longer spawns. */
const removedDependency = "@openai/codex";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the app's documentation describes rc.0", () => {
  for (const relative of documents) {
    const name = relative.replace("../", "");

    test(`${name} names no 0.x engine variable`, () => {
      const text = read(relative);
      // `SMITHERS_REVIEW_MODEL` is a prefix of nothing shipped, but
      // `SMITHERS_REVIEW_SEAT` and friends are live, so match whole names.
      const mentioned = removedVariables.filter((variable) => new RegExp(`\\b${variable}\\b`).test(text));
      expect({ document: name, mentioned }).toEqual({ document: name, mentioned: [] });
    });

    test(`${name} does not offer the Codex CLI`, () => {
      expect({ document: name, mentions: read(relative).includes(removedDependency) }).toEqual({
        document: name,
        mentions: false,
      });
    });

    test(`${name} documents the seats that exist`, () => {
      const text = read(relative);
      // The positive half: a document that dropped every stale name while
      // saying nothing about seats would pass the checks above and still leave
      // a reader with no way to choose a model.
      expect(text).toContain("SMITHERS_REVIEW_SEAT");
    });
  }
});

const siteGuide = "../../site/src/content/docs/docs/guides/pr-review-action.mdx";

describe("documented review commands", () => {
  test("the guide's comment commands match the action trigger and start a review", () => {
    const trigger = read("../action/src/gateEvent.ts").match(/const MAGIC_PHRASE = "([^"]+)";/)?.[1];
    if (!trigger) throw new Error("The action trigger constant was not found");
    const commands = read(siteGuide).match(/@[\w-]+ review/g) ?? [];
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const command of commands) {
      expect(command).toBe(trigger);
      expect(gateEvent({
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 42, pull_request: {} },
          comment: { body: command, author_association: "MEMBER" },
        },
      })).toEqual({ run: true, eventName: "issue_comment", prNumber: 42 });
    }
  });

  for (const relative of ["../README.md", siteGuide, "../src/cli/main.ts", "../docs/commands.md"]) {
    test(`${relative} disables every model-backed step in no-seats examples`, () => {
      const examples = read(relative).split("\n").filter((line) =>
        /^\s*(?:smithers-review|\$\{command\})\s/.test(line) &&
        line.includes("--no-review") && line.includes("--no-narrate")
      );
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        // CLI help separates the command and its description with two spaces.
        const command = example.trim().split(/\s{2,}/)[0]!;
        const args = parseReviewArgs(command.split(/\s+/).slice(1));
        expect({ review: args.review, narrate: args.narrate, quiz: args.quiz }).toEqual({
          review: false,
          narrate: false,
          quiz: "off",
        });
      }
    });
  }
});

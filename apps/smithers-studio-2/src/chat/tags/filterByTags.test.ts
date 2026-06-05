import { describe, expect, it } from "bun:test";
import { filterByTags } from "./filterByTags";
import { collectTags } from "./collectTags";
import type { ChatItem } from "../feed/ChatItem";

function item(id: string, labels: string[]): ChatItem {
  return {
    id,
    role: "assistant",
    projectId: "p",
    timestampMs: 0,
    tags: labels.map((label) => ({ id: label, label, kind: "topic" })),
    body: { kind: "markdown", text: id },
  };
}

const items = [item("a", ["auth"]), item("b", ["auth", "pr-42"]), item("c", ["billing"])];

describe("filterByTags", () => {
  it("passes everything when no filter is active (empty selection → all)", () => {
    expect(filterByTags(items, []).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("filters to items carrying the single active tag", () => {
    expect(filterByTags(items, ["auth"]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("ORs multiple active tags (union — any match)", () => {
    expect(filterByTags(items, ["auth", "billing"]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("union never shrinks: adding a tag only adds items", () => {
    const one = filterByTags(items, ["billing"]).map((i) => i.id);
    const two = filterByTags(items, ["billing", "pr-42"]).map((i) => i.id);
    expect(one).toEqual(["c"]);
    expect(two).toEqual(["b", "c"]);
  });

  it("returns empty when active tags match nothing", () => {
    expect(filterByTags(items, ["nonexistent"])).toHaveLength(0);
  });
});

describe("collectTags", () => {
  it("collects unique tags by label, first-seen wins", () => {
    expect(collectTags(items).map((t) => t.label)).toEqual(["auth", "pr-42", "billing"]);
  });
});

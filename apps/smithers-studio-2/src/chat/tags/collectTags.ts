import type { ChatItem } from "../feed/ChatItem";
import type { Tag } from "./Tag";

/**
 * Collect the unique tags across a feed (dedup by label, first-seen wins) for
 * the TopBar filter bar. Pure — unit-testable without a DOM.
 */
export function collectTags(items: ChatItem[]): Tag[] {
  const byLabel = new Map<string, Tag>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (!byLabel.has(tag.label)) byLabel.set(tag.label, tag);
    }
  }
  return [...byLabel.values()];
}

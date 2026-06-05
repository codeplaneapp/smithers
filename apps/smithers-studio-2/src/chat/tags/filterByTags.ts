import type { ChatItem } from "../feed/ChatItem";

/**
 * Filter chat items by active tag labels. Empty filter = pass everything
 * (the default, unfiltered view). Multiple active tags = union (OR): an item is
 * shown if it carries ANY active tag, so selecting more tags shows more
 * messages, never fewer (design spec §3). Pure — unit-testable without a DOM.
 */
export function filterByTags(items: ChatItem[], activeTagFilters: string[]): ChatItem[] {
  if (activeTagFilters.length === 0) return items;
  const active = new Set(activeTagFilters);
  return items.filter((item) => item.tags.some((tag) => active.has(tag.label)));
}

import type { Tag } from "./Tag";
import { tagColor } from "./tagColor";
import { useChatStore } from "../chatStore";

const PREFIX: Record<Tag["kind"], string> = {
  topic: "#",
  workflow: "⚙",
  issue: "○",
  pr: "◷",
};

/**
 * The TopBar tag filter bar. Renders one toggle chip per unique tag in the feed;
 * clicking toggles a filter on the chat stream (active filters live in the chat
 * store + URL). Chips are **display + filter only** — no edit/rename/delete
 * affordance (tags are AI-managed; the user changes them by asking the agent).
 * Colors come from the stable `tagColor` hash.
 */
export function TagFilterBar({ tags }: { tags: Tag[] }) {
  const activeTagFilters = useChatStore((s) => s.activeTagFilters);
  const toggleTagFilter = useChatStore((s) => s.toggleTagFilter);
  const clearTagFilters = useChatStore((s) => s.clearTagFilters);

  if (tags.length === 0) return null;

  return (
    <div className="tag-filter-bar" data-testid="tag-filter-bar">
      {tags.map((tag) => {
        const color = tagColor(tag);
        const active = activeTagFilters.includes(tag.label);
        return (
          <button
            aria-pressed={active}
            className={active ? "tag-filter tag-filter--active" : "tag-filter"}
            data-testid="tag-filter"
            key={tag.label}
            onClick={() => toggleTagFilter(tag.label)}
            style={{ color, borderColor: color, ["--tag-color" as string]: color }}
            title={`Filter by ${tag.kind}: ${tag.label}`}
            type="button"
          >
            <span className="tag-filter-glyph">{PREFIX[tag.kind]}</span>
            {tag.label}
          </button>
        );
      })}
      {activeTagFilters.length > 0 && (
        <button
          className="tag-filter-clear"
          data-testid="tag-filter-clear"
          onClick={clearTagFilters}
          title="Clear tag filters"
          type="button"
        >
          clear
        </button>
      )}
    </div>
  );
}

import { Tabs, TabsContent, TabsList, TabsTrigger } from "smithers-orchestrator/ui";
import type { PublicIssue, PublicStorySection } from "../types";
import { BriefList } from "./BriefList";
import { CoverageFooter } from "./CoverageFooter";
import { LighterSide } from "./LighterSide";
import { StoryCard } from "./StoryCard";

const SECTION_ORDER: Array<{ key: PublicStorySection; label: string }> = [
  { key: "topStories", label: "Top Stories" },
  { key: "competitive", label: "Competitive Moves" },
  { key: "signals", label: "Signals" },
  { key: "risk", label: "Risk Radar" },
  { key: "opportunities", label: "Opportunities" },
];

export function IssueView(props: { issue: PublicIssue }) {
  const { issue } = props;
  const sectionsWithStories = SECTION_ORDER.filter((section) => issue.stories.some((story) => story.sections.includes(section.key)));
  const defaultSection = sectionsWithStories[0]?.key ?? "topStories";

  return (
    <article className="signal-issue">
      <BriefList brief={issue.brief} />

      {sectionsWithStories.length > 0 ? (
        <Tabs defaultValue={defaultSection}>
          <TabsList>
            {sectionsWithStories.map((section) => (
              <TabsTrigger key={section.key} value={section.key} count={issue.stories.filter((story) => story.sections.includes(section.key)).length}>
                {section.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {sectionsWithStories.map((section) => (
            <TabsContent key={section.key} value={section.key}>
              <div className="signal-story-grid">
                {issue.stories
                  .filter((story) => story.sections.includes(section.key))
                  .map((story) => (
                    <StoryCard key={story.id} story={story} />
                  ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <p className="signal-quiet-day">No qualifying stories today — a quiet day for agent orchestration.</p>
      )}

      {issue.ourMove.length > 0 ? (
        <section className="signal-our-move">
          <h2>Our Move</h2>
          <ul>
            {issue.ourMove.map((move, index) => (
              <li key={index}>
                <strong>{move.action}</strong> — {move.rationale}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <LighterSide items={issue.lighterSide} />
      <CoverageFooter coverage={issue.coverage} />
    </article>
  );
}

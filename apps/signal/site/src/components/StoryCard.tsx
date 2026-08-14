import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "smthrs/ui";
import type { PublicStory } from "../types";

const SECTION_LABELS: Record<string, string> = {
  topStories: "Top Stories",
  competitive: "Competitive Moves",
  signals: "Signals",
  risk: "Risk Radar",
  opportunities: "Opportunities",
};

export function StoryCard(props: { story: PublicStory }) {
  const { story } = props;
  return (
    <Card className="signal-story-card">
      <CardHeader>
        <CardTitle>{story.headline}</CardTitle>
        <CardDescription>{story.dek}</CardDescription>
      </CardHeader>
      <CardContent>
        <p>{story.whatHappened}</p>
        <p className="signal-why-it-matters">
          <strong>Why it matters:</strong> {story.whyItMatters}
        </p>
        {story.recommendedAction ? (
          <p className="signal-recommended-action">
            <strong>Our move:</strong> {story.recommendedAction}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="signal-story-footer">
        <div className="signal-story-badges">
          {story.sections
            .filter((section) => section !== "topStories" || story.sections.length === 1)
            .map((section) => (
              <Badge key={section} variant="outline">
                {SECTION_LABELS[section] ?? section}
              </Badge>
            ))}
          {story.isUpdate ? <Badge variant="secondary">Updated</Badge> : null}
        </div>
        <div className="signal-story-sources">
          {story.sources.map((source, index) => (
            <Button key={`${source.id}-${index}`} asChild variant="link" size="sm">
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.name} ↗
              </a>
            </Button>
          ))}
        </div>
      </CardFooter>
    </Card>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from "smthrs/ui";
import type { PublicIssue } from "../types";

/** "The Brief" — the 3-item, 60-second read above the fold. */
export function BriefList(props: { brief: PublicIssue["brief"] }) {
  if (props.brief.length === 0) return null;
  return (
    <Card className="signal-brief">
      <CardHeader>
        <CardTitle>The Brief</CardTitle>
      </CardHeader>
      <CardContent>
        <ol>
          {props.brief.map((item, index) => (
            <li key={item.storyId ?? index}>
              <strong>{item.headline}.</strong> {item.text}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

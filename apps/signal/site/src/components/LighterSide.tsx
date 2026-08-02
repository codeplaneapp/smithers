import { Button, Card, CardContent, CardHeader, CardTitle } from "smthrs/ui";
import type { PublicIssue } from "../types";

/** The Lighter Side — always the closer. */
export function LighterSide(props: { items: PublicIssue["lighterSide"] }) {
  if (props.items.length === 0) return null;
  return (
    <Card className="signal-lighter-side">
      <CardHeader>
        <CardTitle>The Lighter Side</CardTitle>
      </CardHeader>
      <CardContent>
        <ul>
          {props.items.map((item, index) => (
            <li key={index}>
              {item.text}{" "}
              <Button asChild variant="link" size="sm">
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.sourceName} ↗
                </a>
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusPill,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "smthrs/ui";
import type { PublicIssue } from "../types";

/** Transparency footer: every source checked today, ok or not, plus totals. */
export function CoverageFooter(props: { coverage: PublicIssue["coverage"] }) {
  const { coverage } = props;
  return (
    <Card className="signal-coverage">
      <CardHeader>
        <CardTitle>Coverage</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableCaption>
            {coverage.totals.fetched} items fetched · {coverage.totals.inWindow} in the 24h window ·{" "}
            {coverage.totals.afterDedupe} after dedupe · {coverage.totals.clusters} event clusters ·{" "}
            {coverage.totals.assessed} assessed · {coverage.totals.selected} selected
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Items</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {coverage.sourcesChecked.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell>
                  <StatusPill status={row.ok ? "ok" : "failed"} label={row.ok ? "Checked" : (row.error ?? "Failed")} />
                </TableCell>
                <TableCell>{row.itemCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {coverage.dateUncertain.length > 0 ? (
          <details className="signal-date-uncertain">
            <summary>{coverage.dateUncertain.length} date-uncertain item(s) excluded</summary>
            <ul>
              {coverage.dateUncertain.map((item, index) => (
                <li key={index}>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.title}
                  </a>{" "}
                  ({item.sourceName})
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

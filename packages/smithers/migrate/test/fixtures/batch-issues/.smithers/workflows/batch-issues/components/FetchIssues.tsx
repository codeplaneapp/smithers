import { getLinearClient, useLinear } from "smithers";
import { Task, outputs } from "../smithers";
import { SMITHERS_TEAM_KEY, BLOCKED_ISSUE_IDS, BLOCKED_LABELS } from "../config";

const PAGE_SIZE = 100;
const MAX_PAGES = 25;

export function FetchIssues() {
  return (
    <Task id="fetch-issues" output={outputs.fetchIssues}>
      {async () => {
        const linear = useLinear();
        const client = getLinearClient();

        // Resolve team key (e.g. "JJH") to UUID
        const teams = await linear.listTeams();
        const team = teams.find((t) => t.key === SMITHERS_TEAM_KEY);
        if (!team) {
          throw new Error(`Linear team with key "${SMITHERS_TEAM_KEY}" not found. Available: ${teams.map((t) => t.key).join(", ")}`);
        }

        const issues: any[] = [];
        let after: string | undefined;
        let hasMore = true;

        for (let page = 0; page < MAX_PAGES && hasMore; page += 1) {
          const connection = await client.issues({
            filter: {
              team: { id: { eq: team.id } },
              state: {
                type: { in: ["unstarted", "started", "backlog", "triage"] },
              },
            },
            includeArchived: false,
            first: PAGE_SIZE,
            after,
          });

          issues.push(...connection.nodes);
          hasMore = !!connection.pageInfo?.hasNextPage;

          if (hasMore) {
            if (!connection.pageInfo?.endCursor) {
              throw new Error("Linear pagination failed: missing endCursor");
            }
            after = connection.pageInfo.endCursor;
          }
        }

        if (hasMore) {
          throw new Error(
            `Linear pagination reached MAX_PAGES=${MAX_PAGES}. Increase limits or tighten filters.`,
          );
        }

        const blockedLabels = new Set(BLOCKED_LABELS.map((label) => label.toLowerCase()));
        const mapped = await Promise.all(
          issues.map(async (issue) => {
            const [state, labels] = await Promise.all([
              issue.state,
              issue.labels(),
            ]);
            const labelNames = (labels?.nodes ?? []).map((l: any) => l.name);
            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description ?? null,
              priority: issue.priority,
              priorityLabel: issue.priorityLabel,
              state: state?.name ?? null,
              labels: labelNames,
            };
          }),
        );

        // Filter out known blocked SDK issues
        const filtered = mapped.filter((issue) => {
          if (BLOCKED_ISSUE_IDS.includes(issue.identifier)) {
            return false;
          }
          return !issue.labels.some((label) =>
            blockedLabels.has(label.toLowerCase()),
          );
        });

        return { issues: filtered, count: filtered.length };
      }}
    </Task>
  );
}

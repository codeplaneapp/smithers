import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  SectionHeader,
} from "@smithers-orchestrator/ui";

const meta: Meta = {
  title: "Primitives/Card",
};

export default meta;
type Story = StoryObj;

export const Anatomy: Story = {
  render: () => (
    <Card style={{ maxWidth: 420 }}>
      <CardHeader>
        <CardTitle>Release run</CardTitle>
        <CardDescription>v0.30.0 publish pipeline</CardDescription>
      </CardHeader>
      <CardContent>
        Fourteen of sixteen nodes complete. The publish gate is waiting on a green faults suite.
      </CardContent>
      <CardFooter>
        <Button size="sm">Open run</Button>
      </CardFooter>
    </Card>
  ),
};

export const KpiRow: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
      <KpiStat label="Runs today" value="128" hint="+12% vs yesterday" />
      <KpiStat label="Success rate" value="97.4%" />
      <KpiStat label="Median duration" value="4m 32s" hint="across all workflows" />
    </div>
  ),
};

export const SectionHeaders: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: 560 }}>
      <SectionHeader
        eyebrow="Workspace"
        title="Active runs"
        actions={
          <Button size="sm" variant="outline">
            Refresh
          </Button>
        }
      />
      <SectionHeader title="Recent approvals" />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <EmptyState
      title="No runs yet"
      description="Start a workflow to see live run state here."
      action={<Button size="sm">Start a run</Button>}
    />
  ),
};

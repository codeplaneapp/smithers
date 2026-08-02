import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Plan,
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
  TaskItem,
} from "@smthrs/ui";

const meta: Meta = {
  title: "Agentic/Plans & Queues",
};

export default meta;
type Story = StoryObj;

export const PlanSteps: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <Plan
        streaming
        steps={[
          { id: "inspect", label: "Inspect files", status: "done" },
          {
            id: "implement",
            label: "Implement changes",
            status: "active",
            detail: <TaskItem label="Update Plan.tsx" status="running" />,
          },
          { id: "test", label: "Run the suite", status: "pending" },
          { id: "docs", label: "Update docs", status: "skipped" },
        ]}
      />
    </div>
  ),
};

export const TaskItems: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "0.5rem", maxWidth: 640 }}>
      <TaskItem label="Run focused tests" status="running" files={["tests/plan.test.tsx"]} elapsedSeconds={72} />
      <TaskItem label="Typecheck the workspace" status="complete" elapsedSeconds={143} />
      <TaskItem label="Publish the package" status="failed" />
      <TaskItem label="Regenerate docs bundles" status="pending" />
    </div>
  ),
};

export const WorkQueue: Story = {
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <Queue>
        <QueueSection defaultOpen>
          <QueueSectionTrigger>
            <QueueSectionLabel label="Pending reviews" count={2} />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList>
              <QueueItem completed>
                <QueueItemIndicator />
                <QueueItemContent>Write tests</QueueItemContent>
                <QueueItemDescription>Cover the new queue family</QueueItemDescription>
              </QueueItem>
              <QueueItem status="running">
                <QueueItemIndicator />
                <QueueItemContent>Ship release</QueueItemContent>
              </QueueItem>
              <QueueItem>
                <QueueItemIndicator />
                <QueueItemContent>Close the milestone</QueueItemContent>
              </QueueItem>
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      </Queue>
    </div>
  ),
};

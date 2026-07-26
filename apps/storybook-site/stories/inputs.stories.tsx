import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@smithers-orchestrator/ui";

const meta: Meta = {
  title: "Primitives/Inputs",
};

export default meta;
type Story = StoryObj;

export const TextField: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "0.5rem", maxWidth: 360 }}>
      <Label htmlFor="workflow-name">Workflow name</Label>
      <Input id="workflow-name" placeholder="release-train" />
      <Input placeholder="Disabled" disabled />
    </div>
  ),
};

export const TabsAnatomy: Story = {
  render: () => (
    <Tabs defaultValue="events" style={{ maxWidth: 480 }}>
      <TabsList>
        <TabsTrigger value="events" count={42}>
          Events
        </TabsTrigger>
        <TabsTrigger value="output">Output</TabsTrigger>
        <TabsTrigger value="approvals" count={2}>
          Approvals
        </TabsTrigger>
      </TabsList>
      <TabsContent value="events">The run event log renders here.</TabsContent>
      <TabsContent value="output">Node output rows render here.</TabsContent>
      <TabsContent value="approvals">Pending approval gates render here.</TabsContent>
    </Tabs>
  ),
};

export const DialogAnatomy: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Cancel run</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this run?</DialogTitle>
          <DialogDescription>In-flight tasks are asked to stop; completed work is kept.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost">Keep running</Button>
          <Button variant="destructive">Cancel run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

export const TooltipAnatomy: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="secondary">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Reruns the node with a fresh attempt budget.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
};

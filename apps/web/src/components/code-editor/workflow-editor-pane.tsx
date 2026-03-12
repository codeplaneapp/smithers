import type { WorkflowDocument } from "@mr-burns/shared"

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function WorkflowEditorPane({
  workflow,
  onCreateNew,
  onDelete,
  onEditWithAi,
  isDeleting = false,
}: {
  workflow: WorkflowDocument | null
  onCreateNew?: () => void
  onDelete?: () => void
  onEditWithAi?: () => void
  isDeleting?: boolean
}) {
  return (
    <Card className="gap-4 xl:h-full xl:min-h-0 xl:flex xl:flex-col">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <CardTitle>{workflow ? workflow.name : "Select a workflow"}</CardTitle>
          <CardDescription>
            {workflow
              ? "Preview the current workflow source."
              : "Choose a workflow from the list to inspect its source."}
          </CardDescription>
        </div>
        <CardAction className="flex items-center gap-2">
          <Button variant="outline" onClick={onCreateNew}>
            New workflow
          </Button>
          <Button variant="outline" disabled={!workflow} onClick={onEditWithAi}>
            Edit with AI
          </Button>
          <Button variant="destructive" disabled={!workflow || isDeleting} onClick={onDelete}>
            {isDeleting ? "Deleting…" : "Delete"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden xl:min-h-0">
        {workflow ? (
          <CodeBlock className="flex-1 min-h-0" code={workflow.source} language="tsx" showLineNumbers>
            <CodeBlockHeader>
              <CodeBlockTitle>
                <CodeBlockFilename>workflow.tsx</CodeBlockFilename>
              </CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        ) : (
          <div className="flex h-full min-h-0 items-center justify-center rounded-xl border px-6 text-sm text-muted-foreground">
            Select a workflow to preview highlighted source.
          </div>
        )}
      </CardContent>
    </Card>
  )
}

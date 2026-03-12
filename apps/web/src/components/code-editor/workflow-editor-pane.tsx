import type { WorkflowDocument } from "@burns/shared"

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block"
import {
  Card,
  CardContent,
} from "@/components/ui/card"

export function WorkflowEditorPane({
  workflow,
  sourceOverride,
  fileName = "workflow.tsx",
}: {
  workflow: WorkflowDocument | null
  sourceOverride?: string | null
  fileName?: string
}) {
  const source = sourceOverride ?? workflow?.source ?? null

  return (
    <Card className="m-0 gap-0 rounded-none border border-border border-l-0 py-2 pl-0 pr-2 ring-0 xl:h-full xl:min-h-0 xl:flex xl:flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 px-0 overflow-hidden xl:min-h-0">
        {source ? (
          <CodeBlock className="flex-1 min-h-0" code={source} language="tsx" showLineNumbers>
            <CodeBlockHeader>
              <CodeBlockTitle>
                <CodeBlockFilename>{fileName}</CodeBlockFilename>
              </CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        ) : (
          <div className="flex h-full min-h-0 items-center justify-center rounded-xl border px-6 text-sm text-muted-foreground">
            Select a file to preview highlighted source.
          </div>
        )}
      </CardContent>
    </Card>
  )
}

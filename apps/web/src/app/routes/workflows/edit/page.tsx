import { CheckIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useAgentClis } from "@/features/agents/hooks/use-agent-clis"
import { WorkflowAuthoringConversationPanel } from "@/features/workflows/components/workflow-authoring-conversation-panel"
import { useEditWorkflow } from "@/features/workflows/hooks/use-edit-workflow"
import { useWorkflow } from "@/features/workflows/hooks/use-workflow"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function EditWorkflowPage() {
  const navigate = useNavigate()
  const { workflowId } = useParams()
  const { workspace, workspaceId } = useActiveWorkspace()
  const { data: agentClis = [], isLoading: isAgentListLoading } = useAgentClis()
  const { data: workflows = [], isLoading: isWorkflowListLoading } = useWorkflows(workspace?.id)
  const { data: workflowDocument, isLoading: isWorkflowLoading } = useWorkflow(
    workspace?.id,
    workflowId
  )
  const editWorkflow = useEditWorkflow(workspace?.id, workflowId)

  const [prompt, setPrompt] = useState(
    "Update this workflow to add an approval gate before deploy and preserve stable task IDs."
  )
  const [selectedAgentId, setSelectedAgentId] = useState<string>("")
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)
  const resolvedSelectedAgentId = selectedAgentId || agentClis[0]?.id || ""
  const workflowsBasePath = workspaceId ? `/w/${workspaceId}/workflows` : "/"

  useEffect(() => {
    if (!workflowId || isWorkflowListLoading) {
      return
    }

    if (workflows.every((workflow) => workflow.id !== workflowId)) {
      navigate(workflowsBasePath, { replace: true })
    }
  }, [isWorkflowListLoading, navigate, workflowId, workflows, workflowsBasePath])

  const selectedAgent = useMemo(
    () => agentClis.find((agent) => agent.id === resolvedSelectedAgentId) ?? null,
    [agentClis, resolvedSelectedAgentId]
  )

  const previewWorkflow = editWorkflow.data ?? workflowDocument ?? null

  const submitStatus = editWorkflow.isPending ? "streaming" : "ready"
  const errorMessage =
    editWorkflow.error?.message === "[object Object]"
      ? "Workflow edit failed with a malformed error payload. Check daemon logs for details."
      : editWorkflow.error?.message ?? null

  function handleAgentSubmit(message: PromptInputMessage) {
    if (!workspace || !workflowId || !resolvedSelectedAgentId) {
      return
    }

    const submittedPrompt = message.text?.trim() || prompt.trim()
    if (!submittedPrompt) {
      return
    }

    setPrompt(submittedPrompt)
    editWorkflow.mutate({
      agentId: resolvedSelectedAgentId,
      prompt: submittedPrompt,
    })
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden xl:overflow-y-hidden">
      <div className="grid w-full min-w-0 max-w-full gap-4 p-6 xl:h-full xl:min-h-0 xl:grid-cols-[28rem_1fr] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <Card className="min-w-0 xl:flex xl:min-h-0 xl:flex-col">
          <CardHeader>
            <CardTitle>Workflow editor agent</CardTitle>
          </CardHeader>
          <CardContent className="xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="workflow-name">Workflow name</FieldLabel>
                <Input
                  id="workflow-name"
                  value={workflowDocument?.name ?? workflowId ?? ""}
                  readOnly
                  disabled
                />
              </Field>

              <Field>
                <FieldLabel>Edit prompt</FieldLabel>
                <PromptInput onSubmit={handleAgentSubmit}>
                  <PromptInputBody>
                    <PromptInputTextarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="Describe how the current workflow should change"
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools className="min-w-0 flex-1">
                      <ModelSelector
                        open={isModelSelectorOpen}
                        onOpenChange={setIsModelSelectorOpen}
                      >
                        <ModelSelectorTrigger
                          render={
                            <PromptInputButton
                              className="max-w-full justify-start overflow-hidden"
                              size="sm"
                            />
                          }
                        >
                          {selectedAgent ? (
                            <>
                              <ModelSelectorLogo provider={selectedAgent.logoProvider} />
                              <ModelSelectorName className="truncate">
                                {selectedAgent.name}
                              </ModelSelectorName>
                            </>
                          ) : (
                            <ModelSelectorName>Select agent</ModelSelectorName>
                          )}
                        </ModelSelectorTrigger>
                        <ModelSelectorContent title="Installed agent CLIs">
                          <ModelSelectorInput placeholder="Search installed agent CLIs..." />
                          <ModelSelectorList>
                            <ModelSelectorEmpty>No installed agent CLIs found.</ModelSelectorEmpty>
                            <ModelSelectorGroup heading="Installed agent CLIs">
                              {agentClis.map((agent) => (
                                <ModelSelectorItem
                                  key={agent.id}
                                  value={agent.id}
                                  onSelect={() => {
                                    setSelectedAgentId(agent.id)
                                    setIsModelSelectorOpen(false)
                                  }}
                                >
                                  <ModelSelectorLogo provider={agent.logoProvider} />
                                  <ModelSelectorName>{agent.name}</ModelSelectorName>
                                  {resolvedSelectedAgentId === agent.id ? (
                                    <CheckIcon className="ml-auto" data-icon="inline-end" />
                                  ) : null}
                                </ModelSelectorItem>
                              ))}
                            </ModelSelectorGroup>
                          </ModelSelectorList>
                        </ModelSelectorContent>
                      </ModelSelector>
                    </PromptInputTools>
                    <PromptInputSubmit
                      disabled={
                        !workflowId ||
                        !prompt.trim() ||
                        !resolvedSelectedAgentId ||
                        isAgentListLoading ||
                        isWorkflowLoading
                      }
                      onStop={editWorkflow.cancel}
                      status={submitStatus}
                    />
                  </PromptInputFooter>
                </PromptInput>
              </Field>

              {errorMessage ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {errorMessage}
                </div>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-4 xl:h-full xl:min-h-0">
          <Card className="min-w-0 xl:flex xl:min-h-0 xl:flex-col">
            <CardHeader>
              <CardTitle>Updated workflow</CardTitle>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden xl:min-h-0">
              {editWorkflow.isPending ? (
                <WorkflowAuthoringConversationPanel
                  isStreaming={editWorkflow.isPending}
                  items={editWorkflow.conversationItems}
                />
              ) : previewWorkflow ? (
                <CodeBlock
                  className="flex-1 min-h-0"
                  code={previewWorkflow.source}
                  language="tsx"
                  showLineNumbers
                >
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
                  Load a workflow, then submit an edit prompt. The preview updates when editing completes.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

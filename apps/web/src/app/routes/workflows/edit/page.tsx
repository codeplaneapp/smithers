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
import { useEditWorkflow } from "@/features/workflows/hooks/use-edit-workflow"
import { useWorkflow } from "@/features/workflows/hooks/use-workflow"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function EditWorkflowPage() {
  const navigate = useNavigate()
  const { workflowId } = useParams()
  const { workspace } = useActiveWorkspace()
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

  useEffect(() => {
    if (!workflowId || isWorkflowListLoading) {
      return
    }

    if (workflows.every((workflow) => workflow.id !== workflowId)) {
      navigate("/workflows", { replace: true })
    }
  }, [isWorkflowListLoading, navigate, workflowId, workflows])

  const selectedAgent = useMemo(
    () => agentClis.find((agent) => agent.id === resolvedSelectedAgentId) ?? null,
    [agentClis, resolvedSelectedAgentId]
  )

  const previewWorkflow = editWorkflow.data ?? workflowDocument ?? null

  const submitStatus = editWorkflow.isPending ? "submitted" : "ready"

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
    <div className="flex flex-col">
      <div className="grid gap-4 p-6 xl:grid-cols-[28rem_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Workflow editor agent</CardTitle>
          </CardHeader>
          <CardContent>
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
                      status={submitStatus}
                    />
                  </PromptInputFooter>
                </PromptInput>
              </Field>

              {editWorkflow.error ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {editWorkflow.error.message}
                </div>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Updated workflow</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {previewWorkflow ? (
                <CodeBlock
                  className="max-h-[36rem]"
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
                <div className="flex min-h-[28rem] items-center justify-center rounded-xl border px-6 text-sm text-muted-foreground">
                  Load a workflow, then submit an edit prompt to preview the updated file.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

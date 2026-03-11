import { CheckIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"

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
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAgentClis } from "@/features/agents/hooks/use-agent-clis"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"
import { useGenerateWorkflow } from "@/features/workflows/hooks/use-generate-workflow"

export function NewWorkflowPage() {
  const navigate = useNavigate()
  const { workspace } = useActiveWorkspace()
  const { data: agentClis = [], isLoading: isAgentListLoading } = useAgentClis()
  const generateWorkflow = useGenerateWorkflow(workspace?.id)

  const [name, setName] = useState("issue-to-pr")
  const [prompt, setPrompt] = useState(
    "Create a workflow that takes an issue description, proposes a plan, implements the change, validates it, and summarizes the result."
  )
  const [selectedAgentId, setSelectedAgentId] = useState<string>("")
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)

  const resolvedSelectedAgentId = selectedAgentId || agentClis[0]?.id || ""

  const selectedAgent = useMemo(
    () => agentClis.find((agent) => agent.id === resolvedSelectedAgentId) ?? null,
    [agentClis, resolvedSelectedAgentId]
  )

  const generatedWorkflow = generateWorkflow.data ?? null

  const submitStatus = generateWorkflow.isPending ? "submitted" : "ready"

  function handleAgentSubmit(message: PromptInputMessage) {
    if (!workspace || !resolvedSelectedAgentId) {
      return
    }

    const submittedPrompt = message.text?.trim() || prompt.trim()
    if (!submittedPrompt) {
      return
    }

    setPrompt(submittedPrompt)
    generateWorkflow.mutate({
      name,
      agentId: resolvedSelectedAgentId,
      prompt: submittedPrompt,
    })
  }

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6 xl:grid-cols-[28rem_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Workflow generator</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="workflow-name">Workflow name</FieldLabel>
                <Input
                  id="workflow-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel>Workflow prompt</FieldLabel>
                <PromptInput onSubmit={handleAgentSubmit}>
                  <PromptInputBody>
                    <PromptInputTextarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="Describe the workflow you want to generate"
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
                            <PromptInputButton className="max-w-full justify-start overflow-hidden" size="sm" />
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
                      disabled={!name.trim() || !prompt.trim() || !resolvedSelectedAgentId || isAgentListLoading}
                      status={submitStatus}
                    />
                  </PromptInputFooter>
                </PromptInput>
              </Field>

              {generateWorkflow.error ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {generateWorkflow.error.message}
                </div>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Generated workflow</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {generatedWorkflow ? (
                 <div className="flex justify-end">
                  <Button onClick={() => navigate(`/workflows/${generatedWorkflow.id}`)}>
                    Open in editor
                  </Button>
                </div>
              ) : null}

              {generatedWorkflow ? (
                <CodeBlock
                  className="max-h-[36rem]"
                  code={generatedWorkflow.source}
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
                  Submit a workflow prompt to generate and preview a new workflow.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

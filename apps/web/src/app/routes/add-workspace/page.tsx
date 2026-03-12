import { useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"

import type { Combobox11Option } from "@/components/shadcn-studio/combobox/combobox-11"
import { Combobox11 } from "@/components/shadcn-studio/combobox/combobox-11"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useSettings } from "@/features/settings/hooks/use-settings"
import { ChoiceCardScreen } from "@/features/workspaces/add-workspace/components/choice-card-screen"
import {
  BrowserFolderPickerField,
  DaemonFolderPickerField,
} from "@/features/workspaces/add-workspace/components/folder-picker-field"
import {
  type ManagedWorkspaceSourceChoice,
  managedSourceChoiceOptions,
  type WizardStep,
  type WorkspaceRuntimeChoice,
  runtimeChoiceOptions,
} from "@/features/workspaces/add-workspace/lib/models"
import {
  slugifyWorkspaceName,
  validateLocalPath,
  validateRepositoryUrl,
  validateSmithersUrl,
  validateTargetFolder,
  validateWorkspaceName,
} from "@/features/workspaces/add-workspace/lib/validation"
import { useCreateWorkspace } from "@/features/workspaces/hooks/use-create-workspace"
import { burnsClient, isLocalhostBurnsApiUrl } from "@/lib/api/client"

const workflowTemplateOptions = [
  { value: "issue-to-pr", label: "Issue to PR" },
  { value: "pr-feedback", label: "PR feedback" },
  { value: "approval-gate", label: "Approval gate" },
] satisfies Combobox11Option[]

type FormRowProps = {
  label: string
  htmlFor?: string
  description?: ReactNode
  children: ReactNode
}

function FormRow({ label, htmlFor, description, children }: FormRowProps) {
  return (
    <div className="grid gap-3 border-b py-4 md:grid-cols-[12rem_minmax(0,1fr)] md:items-start md:gap-6">
      <div className="space-y-1">
        <FieldLabel htmlFor={htmlFor} className="text-sm md:pt-2">
          {label}
        </FieldLabel>
      </div>
      <div className="space-y-1.5">
        {children}
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  )
}

export function AddWorkspacePage() {
  const navigate = useNavigate()
  const { data: settings } = useSettings()
  const createWorkspace = useCreateWorkspace()

  const isLocalDaemonUrl = isLocalhostBurnsApiUrl()

  const [step, setStep] = useState<WizardStep>("runtime-choice")
  const [runtimeChoice, setRuntimeChoice] = useState<WorkspaceRuntimeChoice | null>(null)
  const [managedSourceChoice, setManagedSourceChoice] = useState<ManagedWorkspaceSourceChoice | null>(null)

  const [name, setName] = useState("burns-web-app")
  const [repoUrl, setRepoUrl] = useState("")
  const [localPath, setLocalPath] = useState("")
  const [targetFolder, setTargetFolder] = useState("burns-web-app")
  const [smithersBaseUrl, setSmithersBaseUrl] = useState("http://localhost:7331")
  const [selectedWorkflowTemplateIds, setSelectedWorkflowTemplateIds] = useState(
    workflowTemplateOptions.map((option) => option.value)
  )
  const [smithersValidationMessage, setSmithersValidationMessage] = useState<string | null>(null)
  const [isValidatingSmithersUrl, setIsValidatingSmithersUrl] = useState(false)

  const sourceChoices = useMemo(
    () =>
      isLocalDaemonUrl
        ? managedSourceChoiceOptions
        : managedSourceChoiceOptions.filter((option) => option.value !== "local"),
    [isLocalDaemonUrl]
  )

  const isBurnsManaged = runtimeChoice === "burns-managed"
  const isSelfManaged = runtimeChoice === "self-managed"
  const selectedManagedSource = managedSourceChoice

  const nameError = validateWorkspaceName(name)
  const repoUrlError = selectedManagedSource === "clone" ? validateRepositoryUrl(repoUrl) : null
  const localPathError = selectedManagedSource === "local" ? validateLocalPath(localPath) : null
  const targetFolderError =
    isBurnsManaged && selectedManagedSource !== "local" ? validateTargetFolder(targetFolder) : null
  const selfManagedUrlError = isSelfManaged ? validateSmithersUrl(smithersBaseUrl) : null

  const finalFormError =
    nameError ||
    repoUrlError ||
    localPathError ||
    targetFolderError ||
    selfManagedUrlError

  function getPrimaryButtonLabel() {
    if (step !== "final-config") {
      return "Confirm"
    }

    if (isValidatingSmithersUrl) {
      return "Validating..."
    }

    return createWorkspace.isPending ? "Confirming..." : "Confirm"
  }

  function canProceedCurrentStep() {
    if (step === "runtime-choice") {
      return runtimeChoice !== null
    }

    if (step === "source-choice") {
      return managedSourceChoice !== null
    }

    return !finalFormError && !createWorkspace.isPending && !isValidatingSmithersUrl
  }

  function handleBack() {
    if (step === "source-choice") {
      setStep("runtime-choice")
      return
    }

    if (step === "final-config") {
      if (isBurnsManaged) {
        setStep("source-choice")
        return
      }

      setStep("runtime-choice")
    }
  }

  async function handlePickLocalRepoPath() {
    return burnsClient.openNativeFolderPicker()
  }

  async function handleFinalConfirm() {
    const trimmedName = name.trim()
    const trimmedRepoUrl = repoUrl.trim()
    const trimmedLocalPath = localPath.trim()
    const trimmedTargetFolder = targetFolder.trim()
    const trimmedSmithersBaseUrl = smithersBaseUrl.trim()
    const fallbackTargetFolder = slugifyWorkspaceName(trimmedName)

    if (!runtimeChoice) {
      return
    }

    if (runtimeChoice === "self-managed") {
      setSmithersValidationMessage(null)
      setIsValidatingSmithersUrl(true)

      try {
        const validation = await burnsClient.validateSmithersUrl(trimmedSmithersBaseUrl)
        setSmithersValidationMessage(validation.message)
        if (!validation.ok) {
          return
        }
      } finally {
        setIsValidatingSmithersUrl(false)
      }

      const workspace = await createWorkspace.mutateAsync({
        name: trimmedName,
        runtimeMode: "self-managed",
        sourceType: "create",
        smithersBaseUrl: trimmedSmithersBaseUrl,
        targetFolder: fallbackTargetFolder,
      })
      navigate(`/w/${workspace.id}/overview`)
      return
    }

    if (!selectedManagedSource) {
      return
    }

    const workspace = await createWorkspace.mutateAsync(
      selectedManagedSource === "local"
        ? {
            name: trimmedName,
            runtimeMode: "burns-managed",
            sourceType: "local",
            localPath: trimmedLocalPath,
            workflowTemplateIds: selectedWorkflowTemplateIds,
          }
        : selectedManagedSource === "clone"
          ? {
              name: trimmedName,
              runtimeMode: "burns-managed",
              sourceType: "clone",
              repoUrl: trimmedRepoUrl,
              targetFolder: trimmedTargetFolder || fallbackTargetFolder,
              workflowTemplateIds: selectedWorkflowTemplateIds,
            }
          : {
              name: trimmedName,
              runtimeMode: "burns-managed",
              sourceType: "create",
              targetFolder: trimmedTargetFolder || fallbackTargetFolder,
              workflowTemplateIds: selectedWorkflowTemplateIds,
            }
    )

    navigate(`/w/${workspace.id}/overview`)
  }

  async function handlePrimaryAction() {
    if (step === "runtime-choice") {
      if (runtimeChoice === "self-managed") {
        setManagedSourceChoice(null)
        setStep("final-config")
        return
      }

      setStep("source-choice")
      return
    }

    if (step === "source-choice") {
      setStep("final-config")
      return
    }

    await handleFinalConfirm()
  }

  return (
    <div className="flex flex-col p-6">
      <div className="mx-auto w-full max-w-4xl rounded-xl border bg-card">
        <div className="border-b px-6 py-5">
          <h1 className="text-xl font-semibold tracking-tight">
            {step === "runtime-choice"
              ? "Smithers Runtime"
              : step === "source-choice"
                ? "Repository Source"
                : "Final Configuration"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {step === "runtime-choice"
              ? "Choose who manages Smithers for this workspace."
              : step === "source-choice"
                ? "Choose how this workspace repository should be set up."
                : "Configure the workspace fields and confirm."}
          </p>
        </div>

        <div className="px-6">
          {step === "runtime-choice" ? (
            <div className="py-5">
              <ChoiceCardScreen
                value={runtimeChoice}
                onChange={(value) => {
                  setRuntimeChoice(value)
                  setSmithersValidationMessage(null)
                }}
                options={runtimeChoiceOptions}
              />
            </div>
          ) : null}

          {step === "source-choice" ? (
            <div className="py-5">
              <ChoiceCardScreen
                value={managedSourceChoice}
                onChange={setManagedSourceChoice}
                options={sourceChoices}
              />
            </div>
          ) : null}

          {step === "final-config" ? (
            <>
              <FormRow
                label="Title"
                htmlFor="workspace-name"
                description="Displayed in the workspace list."
              >
                <Input
                  id="workspace-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Workspace title"
                />
                {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
              </FormRow>

              {isSelfManaged ? (
                <FormRow
                  label="Smithers URL"
                  htmlFor="smithers-base-url"
                  description="Burns will validate that the Smithers HTTP server is reachable."
                >
                  <Input
                    id="smithers-base-url"
                    value={smithersBaseUrl}
                    onChange={(event) => {
                      setSmithersBaseUrl(event.target.value)
                      setSmithersValidationMessage(null)
                    }}
                    placeholder="http://localhost:7331"
                  />
                  {selfManagedUrlError ? (
                    <p className="text-xs text-destructive">{selfManagedUrlError}</p>
                  ) : null}
                  {smithersValidationMessage && !selfManagedUrlError ? (
                    <p className="text-xs text-muted-foreground">{smithersValidationMessage}</p>
                  ) : null}
                </FormRow>
              ) : null}

              {isBurnsManaged && selectedManagedSource === "clone" ? (
                <FormRow
                  label="Repository URL"
                  htmlFor="workspace-repo-url"
                  description="HTTPS, SSH, or git URL."
                >
                  <Input
                    id="workspace-repo-url"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/acme/burns-web-app.git"
                  />
                  {repoUrlError ? <p className="text-xs text-destructive">{repoUrlError}</p> : null}
                </FormRow>
              ) : null}

              {isBurnsManaged && selectedManagedSource === "local" ? (
                <FormRow
                  label="Local repo path"
                  htmlFor="workspace-local-path"
                  description="Use native folder picker or paste an absolute path."
                >
                  <DaemonFolderPickerField
                    id="workspace-local-path"
                    value={localPath}
                    onChange={setLocalPath}
                    placeholder="/Users/you/code/my-repo"
                    pickerLabel="Choose"
                    onPick={handlePickLocalRepoPath}
                  />
                  {localPathError ? <p className="text-xs text-destructive">{localPathError}</p> : null}
                </FormRow>
              ) : null}

              {isBurnsManaged && selectedManagedSource !== "local" ? (
                <FormRow
                  label="Target folder"
                  htmlFor="workspace-target-folder"
                  description={`Relative to workspace root: ${settings?.workspaceRoot ?? "Loading..."}`}
                >
                  <BrowserFolderPickerField
                    id="workspace-target-folder"
                    value={targetFolder}
                    onChange={setTargetFolder}
                    placeholder={slugifyWorkspaceName(name)}
                    pickerLabel="Choose"
                  />
                  {targetFolderError ? (
                    <p className="text-xs text-destructive">{targetFolderError}</p>
                  ) : null}
                </FormRow>
              ) : null}

              {isBurnsManaged ? (
                <FormRow
                  label="Workflows"
                  description="Select templates to pre-seed in .burns/workflows."
                >
                  <Combobox11
                    className="max-w-full"
                    label=""
                    placeholder="Select workflow templates"
                    searchPlaceholder="Search workflow template..."
                    emptyLabel="No workflow template found."
                    options={workflowTemplateOptions}
                    selectedValues={selectedWorkflowTemplateIds}
                    onChange={setSelectedWorkflowTemplateIds}
                  />
                </FormRow>
              ) : null}
            </>
          ) : null}

          {createWorkspace.error ? (
            <div className="py-4">
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {createWorkspace.error.message}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 py-5">
            {step !== "runtime-choice" ? (
              <Button variant="outline" onClick={handleBack} disabled={createWorkspace.isPending}>
                Back
              </Button>
            ) : null}
            <Button onClick={() => void handlePrimaryAction()} disabled={!canProceedCurrentStep()}>
              {getPrimaryButtonLabel()}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react"
import { useNavigate } from "react-router-dom"

import type { CreateWorkspaceInput, WorkspaceSourceType } from "@mr-burns/shared"
import { FolderOpenIcon } from "lucide-react"

import {
  Combobox11,
  type Combobox11Option,
} from "@/components/shadcn-studio/combobox/combobox-11"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettings } from "@/features/settings/hooks/use-settings"
import { useCreateWorkspace } from "@/features/workspaces/hooks/use-create-workspace"
import { burnsClient, isLocalhostBurnsApiUrl } from "@/lib/api/client"

const workflowTemplateOptions = [
  { value: "issue-to-pr", label: "Issue to PR" },
  { value: "pr-feedback", label: "PR feedback" },
  { value: "approval-gate", label: "Approval gate" },
] satisfies Combobox11Option[]

type WorkspaceSourceMode = Extract<WorkspaceSourceType, "local" | "clone" | "create">

type BrowserFolderPickerFieldProps = {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  pickerLabel: string
}

type DaemonFolderPickerFieldProps = {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  pickerLabel: string
  onPick: () => Promise<string | null>
}

type FileWithPath = File & {
  webkitRelativePath?: string
}

type FormRowProps = {
  label: string
  htmlFor?: string
  description?: ReactNode
  children: ReactNode
}

function extractFolderSelection(files: FileList) {
  const first = files.item(0) as FileWithPath | null
  if (!first) {
    return ""
  }

  const relativePath = first.webkitRelativePath ?? ""
  return relativePath.split("/").filter(Boolean)[0] ?? ""
}

function isAbsolutePath(pathValue: string) {
  return (
    pathValue.startsWith("/") ||
    pathValue.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(pathValue)
  )
}

function validateLocalPath(pathValue: string) {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath) {
    return "Repository path is required."
  }

  if (!isAbsolutePath(trimmedPath)) {
    return "Repository path must be an absolute path."
  }

  return null
}

function validateRepositoryUrl(repoUrl: string) {
  const trimmedRepoUrl = repoUrl.trim()
  if (!trimmedRepoUrl) {
    return "Repository URL is required."
  }

  const sshUrlPattern = /^[\w.-]+@[\w.-]+:[\w./-]+(?:\.git)?$/u
  if (sshUrlPattern.test(trimmedRepoUrl)) {
    return null
  }

  try {
    const parsedUrl = new URL(trimmedRepoUrl)
    if (["http:", "https:", "ssh:", "git:"].includes(parsedUrl.protocol)) {
      return null
    }
  } catch {
    // Invalid URL; handled below.
  }

  return "Enter a valid git URL (HTTPS, SSH, or git protocol)."
}

function validateTargetFolder(targetFolder: string) {
  const trimmedTargetFolder = targetFolder.trim()
  if (!trimmedTargetFolder) {
    return "Target folder is required."
  }

  if (isAbsolutePath(trimmedTargetFolder)) {
    return "Target folder must be relative to workspace root."
  }

  if (trimmedTargetFolder.split(/[\\/]+/u).some((segment) => segment === "..")) {
    return "Target folder cannot contain '..' segments."
  }

  return null
}

function BrowserFolderPickerField({
  id,
  value,
  onChange,
  placeholder,
  pickerLabel,
}: BrowserFolderPickerFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [pickerNote, setPickerNote] = useState<string>("")

  useEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }

    input.setAttribute("webkitdirectory", "")
    input.setAttribute("directory", "")
  }, [])

  function handleInputPickerChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files
    if (!files?.length) {
      return
    }

    const selectedFolder = extractFolderSelection(files)
    if (selectedFolder) {
      onChange(selectedFolder)
      setPickerNote("")
    } else {
      setPickerNote("Could not determine selected folder name from browser picker.")
    }

    event.currentTarget.value = ""
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
          <FolderOpenIcon data-icon="inline-start" />
          {pickerLabel}
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          onChange={handleInputPickerChange}
        />
      </div>
      {pickerNote ? <FieldDescription>{pickerNote}</FieldDescription> : null}
    </div>
  )
}

function DaemonFolderPickerField({
  id,
  value,
  onChange,
  placeholder,
  pickerLabel,
  onPick,
}: DaemonFolderPickerFieldProps) {
  const [isPicking, setIsPicking] = useState(false)
  const [pickerNote, setPickerNote] = useState<string>("")

  async function handlePickClick() {
    try {
      setIsPicking(true)
      setPickerNote("")
      const selectedPath = await onPick()
      if (selectedPath) {
        onChange(selectedPath)
      }
    } catch (error) {
      setPickerNote(error instanceof Error ? error.message : "Failed to pick folder.")
    } finally {
      setIsPicking(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" disabled={isPicking} onClick={() => void handlePickClick()}>
          <FolderOpenIcon data-icon="inline-start" />
          {isPicking ? "Opening..." : pickerLabel}
        </Button>
      </div>
      {pickerNote ? <FieldDescription>{pickerNote}</FieldDescription> : null}
    </div>
  )
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

  const [name, setName] = useState("burns-web-app")
  const [sourceType, setSourceType] = useState<WorkspaceSourceMode>("create")
  const [sourceValue, setSourceValue] = useState("")
  const [targetFolder, setTargetFolder] = useState("burns-web-app")
  const [selectedWorkflowTemplateIds, setSelectedWorkflowTemplateIds] = useState(
    workflowTemplateOptions.map((option) => option.value)
  )

  const sourceValueError = sourceType === "clone"
    ? validateRepositoryUrl(sourceValue)
    : sourceType === "local"
      ? validateLocalPath(sourceValue)
      : null

  const targetFolderError = sourceType === "local" ? null : validateTargetFolder(targetFolder)

  async function handlePickLocalRepoPath() {
    return burnsClient.openNativeFolderPicker()
  }

  async function handleCreateWorkspace() {
    const trimmedName = name.trim()
    const trimmedSourceValue = sourceValue.trim()
    const trimmedTargetFolder = targetFolder.trim()

    const payload: CreateWorkspaceInput = sourceType === "local"
      ? {
          name: trimmedName,
          sourceType: "local",
          localPath: trimmedSourceValue,
          workflowTemplateIds: selectedWorkflowTemplateIds,
        }
      : sourceType === "clone"
        ? {
            name: trimmedName,
            sourceType: "clone",
            repoUrl: trimmedSourceValue,
            targetFolder: trimmedTargetFolder,
            workflowTemplateIds: selectedWorkflowTemplateIds,
          }
        : {
            name: trimmedName,
            sourceType: "create",
            targetFolder: trimmedTargetFolder,
            workflowTemplateIds: selectedWorkflowTemplateIds,
          }

    const workspace = await createWorkspace.mutateAsync(payload)
    navigate(`/w/${workspace.id}/overview`)
  }

  const isCreateDisabled =
    createWorkspace.isPending ||
    !name.trim() ||
    !!sourceValueError ||
    !!targetFolderError

  return (
    <div className="flex flex-col p-6">
      <div className="mx-auto w-full max-w-4xl rounded-xl border bg-card">
        <div className="border-b px-6 py-5">
          <h1 className="text-xl font-semibold tracking-tight">Create workspace</h1>
          <p className="text-sm text-muted-foreground">
            Set a title, pick a source, configure paths, and confirm.
          </p>
        </div>

        <div className="px-6">
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
          </FormRow>

          <FormRow label="Source" description="Create new, clone, or add an existing local repository.">
            <Select
              value={sourceType}
              onValueChange={(value) => setSourceType(value as WorkspaceSourceMode)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose source mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="create">Create new repo</SelectItem>
                  <SelectItem value="clone">Clone repository</SelectItem>
                  {isLocalDaemonUrl ? (
                    <SelectItem value="local">Add existing repository</SelectItem>
                  ) : null}
                </SelectGroup>
              </SelectContent>
            </Select>
          </FormRow>

          {sourceType === "clone" ? (
            <FormRow
              label="Repository URL"
              htmlFor="workspace-repo-url"
              description="HTTPS, SSH, or git URL."
            >
              <Input
                id="workspace-repo-url"
                value={sourceValue}
                onChange={(event) => setSourceValue(event.target.value)}
                placeholder="https://github.com/acme/burns-web-app.git"
              />
              {sourceValueError ? (
                <p className="text-xs text-destructive">{sourceValueError}</p>
              ) : null}
            </FormRow>
          ) : null}

          {sourceType === "local" ? (
            <FormRow
              label="Local repo path"
              htmlFor="workspace-local-path"
              description="Use the picker or paste an absolute path."
            >
              <DaemonFolderPickerField
                id="workspace-local-path"
                value={sourceValue}
                onChange={setSourceValue}
                placeholder="/Users/you/code/my-repo"
                pickerLabel="Choose"
                onPick={handlePickLocalRepoPath}
              />
              {sourceValueError ? (
                <p className="text-xs text-destructive">{sourceValueError}</p>
              ) : null}
            </FormRow>
          ) : null}

          {sourceType !== "local" ? (
            <FormRow
              label="Target folder"
              htmlFor="workspace-target-folder"
              description={`Relative to workspace root: ${settings?.workspaceRoot ?? "Loading..."}`}
            >
              <BrowserFolderPickerField
                id="workspace-target-folder"
                value={targetFolder}
                onChange={setTargetFolder}
                placeholder="burns-web-app"
                pickerLabel="Choose"
              />
              {targetFolderError ? (
                <p className="text-xs text-destructive">{targetFolderError}</p>
              ) : null}
            </FormRow>
          ) : null}

          <FormRow
            label="Workflows"
            description="Select templates to pre-seed in .mr-burns/workflows."
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

          {createWorkspace.error ? (
            <div className="py-4">
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {createWorkspace.error.message}
              </div>
            </div>
          ) : null}

          <div className="flex justify-end py-5">
            <Button onClick={() => void handleCreateWorkspace()} disabled={isCreateDisabled}>
              {createWorkspace.isPending ? "Confirming..." : "Confirm"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

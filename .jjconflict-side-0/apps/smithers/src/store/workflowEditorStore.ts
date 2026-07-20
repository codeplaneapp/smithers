import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import {
  applyLaunchDefaults,
  changedFileCount,
  findWorkflowDoc,
  runDoctor,
  summarizeDoctor,
  validateLaunch,
  WORKFLOW_DOCS,
  type WorkflowDoc,
} from "./workflowDocs";

/**
 * The workflow-editor store: the seeded docs plus the per-selection editor
 * buffers (source draft, import drafts, launch inputs), the active tab, the
 * doctor/DAG view flags, and the unsaved-changes confirm gate. Mutations replay
 * the gateway-less feedback pattern the vcs/issues stores use — a chat line plus
 * a transient toast — since this PWA has no backend yet.
 *
 * `applySelection` recomputes every per-doc buffer from the doc, mirroring the
 * Swift `applySelection`/`selectWorkflow` reset; `select` guards it behind an
 * unsaved-changes confirm when any file is dirty.
 */
export type WorkflowEditorTab = "source" | "imports" | "runs" | "app" | "launch";

type WorkflowEditorState = {
  workflows: WorkflowDoc[];
  selectedId: string | null;
  tab: WorkflowEditorTab;
  /** Editor buffer for the selected workflow's source. */
  sourceDraft: string;
  /** path -> draft buffer for each imported file. */
  importDrafts: Record<string, string>;
  selectedImportPath: string | null;
  /** per-field key -> raw string value. */
  launchInputs: Record<string, string>;
  /** per-field key -> inline error. */
  validationErrors: Record<string, string>;
  showDagDetails: boolean;
  /** Whether the doctor has been run for the current selection. */
  doctorRun: boolean;
  /** Workflow awaiting unsaved-changes confirmation. */
  pendingSelectId: string | null;
  /** Set when Run is tapped on a fieldless workflow; reveals the run confirm. */
  pendingRunConfirm: boolean;
  launching: boolean;
  saving: boolean;
  /** Mock frontend lifecycle for the App tab. */
  frontendPhase: "starting" | "ready" | "failed";

  setRoute: (id: string) => void;
  select: (id: string) => void;
  confirmDiscard: () => void;
  cancelDiscard: () => void;
  setTab: (tab: WorkflowEditorTab) => void;
  setSource: (value: string) => void;
  selectImport: (path: string) => void;
  setImportDraft: (path: string, value: string) => void;
  saveAll: () => void;
  setInput: (key: string, value: string) => void;
  toggleBoolInput: (key: string) => void;
  toggleDagDetails: () => void;
  runDoctor: () => void;
  runWorkflow: () => void;
  confirmRun: () => void;
  cancelRun: () => void;
  restartFrontend: () => void;
};

/**
 * Commit a launch: flip the doc to running, reset + re-default inputs, post a run
 * card + toast. Shared by the direct (has-fields) path and the confirmed
 * (no-fields) path. Reads/writes through the store's set/get.
 */
function launchDoc(
  doc: WorkflowDoc,
  set: (partial: Partial<WorkflowEditorState> | ((s: WorkflowEditorState) => Partial<WorkflowEditorState>)) => void,
): void {
  const launched: WorkflowDoc = { ...doc, lastRunStatus: "running", runError: null };
  const resetInputs = applyLaunchDefaults(doc.launchFields, {}, { overwrite: true });
  set((state) => ({
    workflows: state.workflows.map((w) => (w.id === launched.id ? launched : w)),
    launchInputs: resetInputs,
    validationErrors: {},
    launching: false,
    pendingRunConfirm: false,
  }));
  useChatStore.getState().postCard({ kind: "launch", workflowId: doc.id }, `Launched \`${doc.name}\`.`);
  useNotificationsStore.getState().notify({
    title: `Launched ${doc.name}`,
    detail: doc.filePath,
    kind: "transient",
    command: "chat",
  });
}

/** The fresh per-selection buffers a doc resolves to when it becomes active. */
function selectionBuffers(doc: WorkflowDoc): {
  sourceDraft: string;
  importDrafts: Record<string, string>;
  selectedImportPath: string | null;
  launchInputs: Record<string, string>;
  validationErrors: Record<string, string>;
  showDagDetails: boolean;
  doctorRun: boolean;
  pendingRunConfirm: boolean;
  frontendPhase: "starting" | "ready" | "failed";
  tab: WorkflowEditorTab;
} {
  const importDrafts: Record<string, string> = {};
  for (const file of doc.imports) importDrafts[file.path] = file.source;
  const launchInputs = applyLaunchDefaults(doc.launchFields, {}, { overwrite: true });
  return {
    sourceDraft: doc.source,
    importDrafts,
    selectedImportPath: doc.imports[0]?.path ?? null,
    launchInputs,
    validationErrors: {},
    showDagDetails: false,
    doctorRun: false,
    pendingRunConfirm: false,
    frontendPhase: doc.frontend ? "ready" : "starting",
    tab: "source",
  };
}

const FIRST = WORKFLOW_DOCS[0] ?? null;

export const useWorkflowEditorStore = create<WorkflowEditorState>((set, get) => ({
  workflows: WORKFLOW_DOCS,
  selectedId: FIRST?.id ?? null,
  tab: "source",
  sourceDraft: FIRST?.source ?? "",
  importDrafts: FIRST ? selectionBuffers(FIRST).importDrafts : {},
  selectedImportPath: FIRST?.imports[0]?.path ?? null,
  launchInputs: FIRST ? selectionBuffers(FIRST).launchInputs : {},
  validationErrors: {},
  showDagDetails: false,
  doctorRun: false,
  pendingSelectId: null,
  pendingRunConfirm: false,
  launching: false,
  saving: false,
  frontendPhase: FIRST?.frontend ? "ready" : "starting",

  /** Sync the store to the route param without the unsaved-changes guard. */
  setRoute: (id) => {
    const { selectedId, workflows } = get();
    if (id === selectedId) return;
    const doc = findWorkflowDoc(workflows, id);
    if (!doc) return;
    set({ selectedId: id, ...selectionBuffers(doc) });
  },

  select: (id) => {
    const { selectedId, workflows, sourceDraft, importDrafts } = get();
    if (id === selectedId) return;
    const doc = findWorkflowDoc(workflows, selectedId);
    const dirty =
      doc !== null && changedFileCount(doc, sourceDraft, importDrafts) > 0;
    if (dirty) {
      set({ pendingSelectId: id });
      return;
    }
    const next = findWorkflowDoc(workflows, id);
    if (!next) return;
    set({ selectedId: id, ...selectionBuffers(next) });
  },

  confirmDiscard: () => {
    const { pendingSelectId, workflows } = get();
    if (pendingSelectId === null) return;
    const next = findWorkflowDoc(workflows, pendingSelectId);
    if (!next) {
      set({ pendingSelectId: null });
      return;
    }
    set({ selectedId: pendingSelectId, pendingSelectId: null, ...selectionBuffers(next) });
  },

  cancelDiscard: () => set({ pendingSelectId: null }),

  setTab: (tab) => set({ tab }),

  setSource: (value) => set({ sourceDraft: value }),

  selectImport: (path) => set({ selectedImportPath: path }),

  setImportDraft: (path, value) =>
    set((state) => ({ importDrafts: { ...state.importDrafts, [path]: value } })),

  saveAll: () => {
    const { workflows, selectedId, sourceDraft, importDrafts, saving } = get();
    if (saving) return;
    const doc = findWorkflowDoc(workflows, selectedId);
    if (!doc) return;
    const changed = changedFileCount(doc, sourceDraft, importDrafts);
    if (changed === 0) return;
    set({ saving: true });
    const saved: WorkflowDoc = {
      ...doc,
      source: sourceDraft,
      originalSource: sourceDraft,
      imports: doc.imports.map((file) =>
        importDrafts[file.path] !== undefined
          ? { ...file, source: importDrafts[file.path] }
          : file,
      ),
    };
    set((state) => ({
      workflows: state.workflows.map((w) => (w.id === saved.id ? saved : w)),
      saving: false,
    }));
    useChatStore.getState().say(
      `Saved ${changed} file${changed === 1 ? "" : "s"} in \`${saved.filePath}\`.`,
    );
    useNotificationsStore.getState().notify({
      title: "Workflow saved",
      detail: `${saved.name} · ${changed} file${changed === 1 ? "" : "s"}`,
      kind: "transient",
      command: "chat",
    });
  },

  setInput: (key, value) => {
    const { workflows, selectedId, launchInputs } = get();
    const doc = findWorkflowDoc(workflows, selectedId);
    const nextInputs = { ...launchInputs, [key]: value };
    const validationErrors = doc ? validateLaunch(doc.launchFields, nextInputs) : {};
    set({ launchInputs: nextInputs, validationErrors });
  },

  toggleBoolInput: (key) => {
    const { workflows, selectedId, launchInputs } = get();
    const doc = findWorkflowDoc(workflows, selectedId);
    const current = launchInputs[key] === "true";
    const nextInputs = { ...launchInputs, [key]: current ? "false" : "true" };
    const validationErrors = doc ? validateLaunch(doc.launchFields, nextInputs) : {};
    set({ launchInputs: nextInputs, validationErrors });
  },

  toggleDagDetails: () => set((state) => ({ showDagDetails: !state.showDagDetails })),

  runDoctor: () => {
    const { workflows, selectedId } = get();
    const doc = findWorkflowDoc(workflows, selectedId);
    if (!doc) return;
    const issues = runDoctor(doc);
    const summary = summarizeDoctor(issues);
    set((state) => ({
      workflows: state.workflows.map((w) =>
        w.id === doc.id ? { ...w, doctorIssues: issues } : w,
      ),
      doctorRun: true,
    }));
    useChatStore.getState().say(
      `Workflow doctor for \`${doc.name}\`: ` +
        `${summary.ok} ok · ${summary.warning} warning${summary.warning === 1 ? "" : "s"} · ` +
        `${summary.error} error${summary.error === 1 ? "" : "s"}.`,
    );
    useNotificationsStore.getState().notify({
      title: "Doctor finished",
      detail:
        summary.error > 0
          ? `${summary.error} error(s) · ${doc.name}`
          : summary.warning > 0
            ? `${summary.warning} warning(s) · ${doc.name}`
            : `All checks passed · ${doc.name}`,
      kind: "transient",
      command: "chat",
    });
  },

  runWorkflow: () => {
    const { workflows, selectedId, launchInputs, launching } = get();
    if (launching) return;
    const doc = findWorkflowDoc(workflows, selectedId);
    if (!doc) return;
    // No input form: route through the run confirmation instead of launching.
    if (doc.launchFields.length === 0) {
      set({ pendingRunConfirm: true });
      return;
    }
    const validationErrors = validateLaunch(doc.launchFields, launchInputs);
    if (Object.keys(validationErrors).length > 0) {
      set({ validationErrors });
      return;
    }
    set({ launching: true });
    launchDoc(doc, set);
  },

  confirmRun: () => {
    const { workflows, selectedId } = get();
    const doc = findWorkflowDoc(workflows, selectedId);
    if (!doc) {
      set({ pendingRunConfirm: false });
      return;
    }
    set({ launching: true });
    launchDoc(doc, set);
  },

  cancelRun: () => set({ pendingRunConfirm: false }),

  restartFrontend: () => {
    set({ frontendPhase: "starting" });
    set({ frontendPhase: "ready" });
    const { workflows, selectedId } = get();
    const doc = findWorkflowDoc(workflows, selectedId);
    if (doc?.frontend) {
      useChatStore.getState().say(`Restarted the \`${doc.frontend.name}\` frontend.`);
    }
  },
}));

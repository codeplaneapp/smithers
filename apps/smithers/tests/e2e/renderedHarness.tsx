import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const surface = new URLSearchParams(window.location.search).get("surface");

async function renderSurface() {
  switch (surface) {
    case "logs": {
      const [{ LogsCanvas }, { useLogsPrefsStore }] = await Promise.all([
        import("../../src/logs/LogsCanvas"),
        import("../../src/logs/logsPrefsStore"),
      ]);
      useLogsPrefsStore.setState({ follow: true, hideNoise: false, redact: true });
      return <LogsCanvas />;
    }
    case "timeline": {
      const [{ TimelineCanvas }, { useRunsStore }, { useTimelineStore }] = await Promise.all([
        import("../../src/timeline/TimelineCanvas"),
        import("../../src/runs/runsStore"),
        import("../../src/timeline/timelineStore"),
      ]);
      useRunsStore.setState({
        runs: [
          {
            id: "legacy-e2e",
            title: "Auth refactor",
            model: "claude-opus-4-8",
            runId: "legacy-e2e",
            startedAtMs: 1_700_000_000_000,
            frame: 5,
            maxFrame: 5,
            gate: "approved",
            paused: false,
            canceled: false,
          },
        ],
      });
      useTimelineStore.setState({ pendingFrame: null, confirmingRewind: false, error: null });
      return <TimelineCanvas runId="legacy-e2e" />;
    }
    case "diff": {
      const { DiffCanvas } = await import("../../src/diff/DiffCanvas");
      return <DiffCanvas />;
    }
    case "diff-empty": {
      const [{ DiffCanvas }, { AUTH_REFACTOR_DIFF }] = await Promise.all([
        import("../../src/diff/DiffCanvas"),
        import("../../src/diff/authRefactorDiff"),
      ]);
      AUTH_REFACTOR_DIFF.files.splice(0);
      return <DiffCanvas />;
    }
    case "memory-empty": {
      const [{ MemoryCanvas }, { useMemoryStore }] = await Promise.all([
        import("../../src/memory/MemoryCanvas"),
        import("../../src/memory/memoryStore"),
      ]);
      useMemoryStore.setState({
        facts: [],
        mode: "facts",
        namespaceFilter: null,
        selectedFactId: null,
        recallQuery: "",
        recallResults: [],
        hasAttemptedRecall: false,
        isRecalling: false,
        recallError: null,
      });
      return <MemoryCanvas />;
    }
    case "scores-empty": {
      const [{ ScoresCanvas }, { useScoresStore }] = await Promise.all([
        import("../../src/scores/ScoresCanvas"),
        import("../../src/scores/scoresStore"),
      ]);
      useScoresStore.setState({ runs: [], scoreRows: [], selectedRunId: null, tab: "summary" });
      return <ScoresCanvas />;
    }
    case "prompts-empty": {
      const [{ PromptsCanvas }, { usePromptsStore }] = await Promise.all([
        import("../../src/prompts/PromptsCanvas"),
        import("../../src/prompts/promptsStore"),
      ]);
      usePromptsStore.setState({
        prompts: [],
        selectedId: "",
        draftById: {},
        savedById: {},
        valuesById: {},
        tab: "source",
        previewById: {},
        previewing: false,
        pendingSelectId: null,
      });
      return <PromptsCanvas />;
    }
    case "tickets-empty": {
      const [{ TicketsCanvas }, { useTicketsStore }] = await Promise.all([
        import("../../src/tickets/TicketsCanvas"),
        import("../../src/tickets/ticketsStore"),
      ]);
      useTicketsStore.setState({
        tickets: [],
        selectedId: null,
        query: "",
        draftContent: "",
        createOpen: false,
        newId: "",
        newContent: "",
      });
      return <TicketsCanvas />;
    }
    case "store-empty": {
      const { WorkflowStoreContent } = await import("../../src/store/WorkflowStore");
      return <WorkflowStoreContent installed={[]} loading={false} includeGatewaySection={false} />;
    }
    case "store-loading": {
      const { WorkflowStoreContent } = await import("../../src/store/WorkflowStore");
      return <WorkflowStoreContent installed={[]} loading includeGatewaySection={false} />;
    }
    case "vcs-loading":
    case "vcs-no-repo":
    case "vcs-error": {
      const [{ VcsCanvas }, { useVcsStore }] = await Promise.all([
        import("../../src/vcs/VcsCanvas"),
        import("../../src/vcs/vcsStore"),
      ]);
      const load = async () => {};
      if (surface === "vcs-loading") {
        useVcsStore.setState({ snapshot: null, loading: false, error: null, load });
      } else if (surface === "vcs-no-repo") {
        useVcsStore.setState({
          snapshot: {
            workspacePath: "/tmp/no-repository",
            primary: null,
            detected: { jj: false, git: false },
            jj: null,
            git: null,
          },
          loading: false,
          error: null,
          load,
        });
      } else {
        useVcsStore.setState({
          snapshot: null,
          loading: false,
          error: "Local VCS status failed (500)",
          load,
        });
      }
      return <VcsCanvas />;
    }
    default:
      return <div data-testid="harness-error">Unknown surface: {surface}</div>;
  }
}

createRoot(document.getElementById("root")!).render(await renderSurface());

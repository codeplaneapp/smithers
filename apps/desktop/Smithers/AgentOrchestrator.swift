import Foundation

@MainActor
class AgentOrchestrator: ObservableObject {
    let mainWorkspace: URL
    let jjService: JJService
    let snapshotStore: JJSnapshotStore

    @Published var activeAgents: [AgentWorkspace] = []
    @Published var mergeQueue: MergeQueue = MergeQueue()
    @Published var isProcessingQueue: Bool = false

    private var pollingTask: Task<Void, Never>?
    private var queueProcessingTask: Task<Void, Never>?
    private var agentCodexServices: [String: CodexService] = [:]
    private var preferences: VCSPreferences

    init(mainWorkspace: URL, jjService: JJService, snapshotStore: JJSnapshotStore, preferences: VCSPreferences) {
        self.mainWorkspace = mainWorkspace
        self.jjService = jjService
        self.snapshotStore = snapshotStore
        self.preferences = preferences
    }

    // MARK: - Agent Lifecycle

    func spawnAgent(task: String, baseRevision: String = "trunk()") async throws -> AgentWorkspace {
        guard activeAgents.count < preferences.maxConcurrentAgents else {
            throw JJError.commandFailed("Maximum concurrent agents (\(preferences.maxConcurrentAgents)) reached")
        }

        let slug = makeSlug(from: task)
        let basePath = preferences.agentWorkspaceBasePath.map { URL(fileURLWithPath: $0) }
            ?? mainWorkspace.deletingLastPathComponent()
        let workspacePath = basePath.appendingPathComponent(slug)

        // Create jj workspace
        let wsInfo = try await jjService.workspaceAdd(
            path: workspacePath.path,
            revision: baseRevision,
            description: "agent: \(task)"
        )

        // Run setup commands
        for cmd in preferences.agentSetupCommands {
            try await runSetupCommand(cmd, in: workspacePath)
        }

        // Create a CodexService for this agent
        let codexService = CodexService()
        let chatSessionId = UUID().uuidString

        let agent = AgentWorkspace(
            id: slug,
            directory: workspacePath,
            changeId: wsInfo.workingCopyChangeId,
            task: task,
            chatSessionId: chatSessionId,
            status: .running,
            createdAt: Date(),
            filesChanged: []
        )

        activeAgents.append(agent)
        agentCodexServices[slug] = codexService

        // Record in SQLite
        try snapshotStore.recordAgentWorkspace(AgentWorkspaceRecord(
            id: slug,
            workspacePath: workspacePath.path,
            mainWorkspacePath: mainWorkspace.path,
            changeId: wsInfo.workingCopyChangeId,
            task: task,
            chatSessionId: chatSessionId,
            status: AgentStatus.running.rawValue,
            priority: MergeQueuePriority.normal.rawValue,
            createdAt: Date()
        ))

        try snapshotStore.logMergeQueueAction(agentId: slug, action: "spawned", details: task)

        // Start the codex service
        let threadResult = try await codexService.start(cwd: workspacePath.path)
        _ = threadResult

        // Send the task
        try await codexService.sendMessage(task, images: [])

        // Start polling if not already
        startPollingIfNeeded()

        return agent
    }

    func cancelAgent(_ agent: AgentWorkspace) async throws {
        guard let idx = activeAgents.firstIndex(where: { $0.id == agent.id }) else { return }

        // Stop codex service
        if let codex = agentCodexServices[agent.id] {
            codex.stop()
            agentCodexServices.removeValue(forKey: agent.id)
        }

        // Update status
        activeAgents[idx].status = .cancelled

        // Clean up workspace
        try await jjService.workspaceForget(name: agent.id)

        // Clean up directory
        try? FileManager.default.removeItem(at: agent.directory)

        // Update SQLite
        try? snapshotStore.updateAgentStatus(id: agent.id, status: .cancelled)
        try? snapshotStore.logMergeQueueAction(agentId: agent.id, action: "cancelled")

        // Remove from merge queue
        mergeQueue.remove(agentId: agent.id)

        // Remove from active list
        activeAgents.removeAll { $0.id == agent.id }
    }

    func agentCompleted(_ agent: AgentWorkspace) async {
        guard let idx = activeAgents.firstIndex(where: { $0.id == agent.id }) else { return }

        activeAgents[idx].status = .completed

        // Seal the agent's changes
        let agentJJ = JJService(workingDirectory: agent.directory)
        let _ = agentJJ.detectVCS()
        do {
            try await agentJJ.describe(message: "agent(\(agent.id)): \(agent.task)")
            _ = try await agentJJ.newChange()
        } catch {
            // Non-fatal
        }

        // Enqueue for merge
        let entry = MergeQueueEntry(
            id: agent.id,
            agentId: agent.id,
            changeId: agent.changeId,
            task: agent.task,
            priority: .normal,
            status: .waiting,
            enqueuedAt: Date()
        )
        mergeQueue.enqueue(entry)
        activeAgents[idx].status = .inQueue

        try? snapshotStore.updateAgentStatus(id: agent.id, status: .inQueue)
        try? snapshotStore.logMergeQueueAction(agentId: agent.id, action: "enqueued")

        // Auto-process queue if enabled
        if preferences.mergeQueueAutoRun {
            processQueue()
        }
    }

    // MARK: - Merge Queue Processing

    func processQueue() {
        guard !isProcessingQueue else { return }

        queueProcessingTask = Task {
            isProcessingQueue = true
            defer { isProcessingQueue = false }

            while let entry = mergeQueue.dequeue() {
                await processMergeEntry(entry)
            }
        }
    }

    private func processMergeEntry(_ entry: MergeQueueEntry) async {
        let agentId = entry.agentId

        // Step 1: Create merge revision
        try? snapshotStore.logMergeQueueAction(agentId: agentId, action: "merge_started")

        do {
            // Create a merge commit: jj new trunk() <change>
            _ = try await jjService.runMerge(
                trunk: "trunk()",
                changeId: entry.changeId
            )

            // Step 2: Check for conflicts
            let status = try await jjService.status()
            if !status.conflicts.isEmpty {
                mergeQueue.updateStatus(agentId: agentId, status: .conflicted)
                try? snapshotStore.logMergeQueueAction(
                    agentId: agentId,
                    action: "conflicted",
                    details: status.conflicts.joined(separator: ", ")
                )

                if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                    activeAgents[idx].status = .conflicted
                }
                try? snapshotStore.updateAgentStatus(id: agentId, status: .conflicted)

                // Undo the failed merge
                try? await jjService.undo()
                return
            }

            // Step 3: Run tests if configured
            if let testCommand = preferences.mergeQueueTestCommand ?? mergeQueue.testCommand {
                mergeQueue.updateStatus(agentId: agentId, status: .testing)
                try? snapshotStore.logMergeQueueAction(agentId: agentId, action: "test_started")

                let testResult = await runTestCommand(testCommand)

                if testResult.passed {
                    try? snapshotStore.logMergeQueueAction(agentId: agentId, action: "test_passed")
                } else {
                    mergeQueue.updateStatus(agentId: agentId, status: .testFailed)
                    try? snapshotStore.logMergeQueueAction(
                        agentId: agentId,
                        action: "test_failed",
                        details: testResult.output
                    )

                    if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                        activeAgents[idx].status = .failed
                    }
                    try? snapshotStore.updateAgentStatus(id: agentId, status: .failed, testOutput: testResult.output)

                    // Undo the failed merge
                    try? await jjService.undo()
                    return
                }
            }

            // Step 4: Land the change
            mergeQueue.updateStatus(agentId: agentId, status: .landed)
            try? snapshotStore.logMergeQueueAction(agentId: agentId, action: "landed")

            if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                activeAgents[idx].status = .merged
            }
            try? snapshotStore.updateAgentStatus(id: agentId, status: .merged)

            // Clean up workspace
            try? await jjService.workspaceForget(name: agentId)
            if let agent = activeAgents.first(where: { $0.id == agentId }) {
                try? FileManager.default.removeItem(at: agent.directory)
            }

            // Stop codex service
            if let codex = agentCodexServices[agentId] {
                codex.stop()
                agentCodexServices.removeValue(forKey: agentId)
            }

        } catch {
            mergeQueue.updateStatus(agentId: agentId, status: .testFailed)
            try? snapshotStore.logMergeQueueAction(
                agentId: agentId,
                action: "merge_failed",
                details: error.localizedDescription
            )
            if let idx = activeAgents.firstIndex(where: { $0.id == agentId }) {
                activeAgents[idx].status = .failed
            }
            try? snapshotStore.updateAgentStatus(id: agentId, status: .failed)
        }
    }

    // MARK: - Polling

    func startPollingIfNeeded() {
        guard pollingTask == nil else { return }
        pollingTask = Task {
            while !Task.isCancelled {
                await pollAgentStatus()
                try? await Task.sleep(nanoseconds: 5_000_000_000) // 5 seconds
            }
        }
    }

    func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    func pollAgentStatus() async {
        for i in activeAgents.indices {
            guard activeAgents[i].status == .running else { continue }

            let agentJJ = JJService(workingDirectory: activeAgents[i].directory)
            let _ = agentJJ.detectVCS()

            do {
                let files = try await agentJJ.diffSummary()
                activeAgents[i].filesChanged = files
            } catch {
                // Agent workspace may not be ready yet
            }

            // Check if the codex service is still active
            if let codex = agentCodexServices[activeAgents[i].id], !codex.isRunning {
                await agentCompleted(activeAgents[i])
            }
        }

        // Stop polling if no running agents
        if !activeAgents.contains(where: { $0.status == .running }) {
            stopPolling()
        }
    }

    // MARK: - Helpers

    private func makeSlug(from task: String) -> String {
        let words = task.lowercased()
            .components(separatedBy: .alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .prefix(4)
        let slug = "agent-" + words.joined(separator: "-")
        // Ensure uniqueness
        if activeAgents.contains(where: { $0.id == slug }) {
            return slug + "-\(Int.random(in: 100...999))"
        }
        return slug
    }

    private func runSetupCommand(_ command: String, in directory: URL) async throws {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", command]
            process.currentDirectoryURL = directory
            process.environment = ProcessInfo.processInfo.environment

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            try process.run()
            let stdoutTask = Task<Data, Never> {
                stdout.fileHandleForReading.readDataToEndOfFile()
            }
            let stderrTask = Task<Data, Never> {
                stderr.fileHandleForReading.readDataToEndOfFile()
            }

            process.waitUntilExit()

            let _ = await stdoutTask.value
            let stderrData = await stderrTask.value

            if process.terminationStatus != 0 {
                let errorOutput = String(data: stderrData, encoding: .utf8) ?? ""
                throw JJError.commandFailed("Setup command failed: \(command)\n\(errorOutput)")
            }
        }.value
    }

    private func runTestCommand(_ command: String) async -> TestResult {
        let start = Date()
        let wd = mainWorkspace

        return await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", command]
            process.currentDirectoryURL = wd
            process.environment = ProcessInfo.processInfo.environment

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()
                let stdoutTask = Task<Data, Never> {
                    stdout.fileHandleForReading.readDataToEndOfFile()
                }
                let stderrTask = Task<Data, Never> {
                    stderr.fileHandleForReading.readDataToEndOfFile()
                }

                process.waitUntilExit()

                let stdoutData = await stdoutTask.value
                let stderrData = await stderrTask.value
                let output = (String(data: stdoutData, encoding: .utf8) ?? "") +
                             (String(data: stderrData, encoding: .utf8) ?? "")
                let duration = Date().timeIntervalSince(start)

                return TestResult(
                    passed: process.terminationStatus == 0,
                    output: output,
                    duration: duration,
                    command: command
                )
            } catch {
                let duration = Date().timeIntervalSince(start)
                return TestResult(
                    passed: false,
                    output: error.localizedDescription,
                    duration: duration,
                    command: command
                )
            }
        }.value
    }
}

// MARK: - JJService Extension for Merge

extension JJService {
    func runMerge(trunk: String, changeId: String) async throws -> JJChange {
        _ = try await runJJ(["new", trunk, changeId])
        let output = try await runJJ([
            "log", "--no-graph", "-r", "@",
            "-T", Self.changeTemplate
        ])
        return try parseChange(output)
    }
}

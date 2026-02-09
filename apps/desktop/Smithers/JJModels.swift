import Foundation
import GRDB

// MARK: - VCS Detection

enum VCSType {
    case jjColocated   // Both .jj/ and .git/
    case jjNative      // Only .jj/
    case gitOnly       // Only .git/ — offer to init jj
    case none          // No VCS
}

// MARK: - JJ Change Model

struct JJChange: Identifiable, Codable, Hashable {
    let changeId: String
    let commitId: String
    let description: String
    let authorName: String
    let authorEmail: String
    let timestamp: Date
    let isEmpty: Bool
    let isWorkingCopy: Bool
    let parents: [String]
    let bookmarks: [String]

    var id: String { changeId }
    var shortChangeId: String { String(changeId.prefix(8)) }
    var firstLine: String { description.components(separatedBy: "\n").first ?? "" }
}

// MARK: - File Diff

struct JJFileDiff: Identifiable, Codable, Hashable {
    enum Status: String, Codable {
        case modified = "M"
        case added = "A"
        case deleted = "D"
        case renamed = "R"
    }

    let status: Status
    let path: String
    let oldPath: String?

    var id: String { path }

    var statusIcon: String {
        switch status {
        case .modified: return "pencil"
        case .added: return "plus"
        case .deleted: return "minus"
        case .renamed: return "arrow.right"
        }
    }

    var statusColor: String {
        switch status {
        case .modified: return "orange"
        case .added: return "green"
        case .deleted: return "red"
        case .renamed: return "blue"
        }
    }
}

// MARK: - JJ Status

struct JJStatus: Codable {
    let workingCopyChange: JJChange
    let parentChanges: [JJChange]
    let modifiedFiles: [JJFileDiff]
    let conflicts: [String]
    let isColocated: Bool
}

// MARK: - JJ Bookmark

struct JJBookmark: Identifiable, Codable, Hashable {
    let name: String
    let changeId: String
    let isTracking: Bool
    let remote: String?
    let isAhead: Bool
    let isBehind: Bool

    var id: String { name }
}

// MARK: - JJ Operation

struct JJOperation: Identifiable, Codable, Hashable {
    let operationId: String
    let description: String
    let timestamp: Date
    let user: String

    var id: String { operationId }
}

// MARK: - Snapshot Tracking (GRDB)

struct Snapshot: Identifiable, Codable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "snapshots"

    var id: Int64?
    let changeId: String
    let commitId: String?
    let workspacePath: String
    let chatSessionId: String?
    let chatMessageIndex: Int?
    let description: String
    let snapshotType: SnapshotType
    let createdAt: Date
    let metadata: String?

    enum SnapshotType: String, Codable {
        case aiChange = "ai_change"
        case userSave = "user_save"
        case manualCommit = "manual_commit"
    }

    mutating func didInsert(_ inserted: InsertionSuccess) {
        id = inserted.rowID
    }
}

// MARK: - Agent Workspace (GRDB)

struct AgentWorkspaceRecord: Identifiable, Codable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "agent_workspaces"

    let id: String
    let workspacePath: String
    let mainWorkspacePath: String
    let changeId: String
    let task: String
    let chatSessionId: String?
    var status: String
    var priority: Int
    let createdAt: Date
    var completedAt: Date?
    var mergedAt: Date?
    var testOutput: String?
    var conflictFiles: String?
    var metadata: String?
}

// MARK: - Merge Queue Log (GRDB)

struct MergeQueueLogEntry: Identifiable, Codable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "merge_queue_log"

    var id: Int64?
    let agentId: String
    let action: String
    let details: String?
    let timestamp: Date

    mutating func didInsert(_ inserted: InsertionSuccess) {
        id = inserted.rowID
    }
}

// MARK: - Git Notes Metadata

struct SmithersNotePayload: Codable {
    let version: Int
    let smithersSessionId: String
    let prompts: [PromptRecord]
    let model: String?
    let filesChanged: [String]
    let snapshotIds: [String]

    struct PromptRecord: Codable {
        let role: String
        let content: String
        let timestamp: Date
    }

    init(sessionId: String, prompts: [PromptRecord], model: String?, filesChanged: [String], snapshotIds: [String]) {
        self.version = 1
        self.smithersSessionId = sessionId
        self.prompts = prompts
        self.model = model
        self.filesChanged = filesChanged
        self.snapshotIds = snapshotIds
    }
}

// MARK: - Commit Style Detection

enum CommitStyle: Codable, Hashable {
    case conventional
    case emojiConventional
    case ticketPrefixed(String)
    case imperative
    case freeform

    var exampleFormat: String {
        switch self {
        case .conventional: return "feat: add authentication"
        case .emojiConventional: return "✨ feat: add authentication"
        case .ticketPrefixed(let prefix): return "\(prefix)-123: add authentication"
        case .imperative: return "Add authentication"
        case .freeform: return "added authentication"
        }
    }

    var displayName: String {
        switch self {
        case .conventional: return "Conventional Commits"
        case .emojiConventional: return "Emoji + Conventional"
        case .ticketPrefixed(let prefix): return "Ticket Prefixed (\(prefix))"
        case .imperative: return "Imperative Mood"
        case .freeform: return "Freeform"
        }
    }
}

// MARK: - VCS Preferences

struct VCSPreferences: Codable {
    var snapshotOnSave: Bool = true
    var snapshotOnAIChange: Bool = true
    var autoDetectCommitStyle: Bool = true
    var commitStyleOverride: CommitStyle? = nil
    var showInlineBlame: Bool = false
    var aiCommitMessages: Bool = true
    var gitNotesOnCommit: Bool = false
    var defaultRemote: String = "origin"

    var maxConcurrentAgents: Int = 5
    var agentWorkspaceBasePath: String? = nil
    var agentSetupCommands: [String] = []
    var mergeQueueAutoRun: Bool = true
    var mergeQueueTestCommand: String? = nil
    var mergeQueueAutoResolveConflicts: Bool = true
    var mergeQueueSpeculativeMerging: Bool = false
}

// MARK: - JJ Workspace Info

struct JJWorkspaceInfo: Identifiable, Codable, Hashable {
    let name: String
    let path: String
    let workingCopyChangeId: String
    let isStale: Bool

    var id: String { name }
}

// MARK: - Agent Status

enum AgentStatus: String, Codable, Hashable {
    case running
    case completed
    case failed
    case inQueue
    case merging
    case merged
    case conflicted
    case cancelled

    var displayName: String {
        switch self {
        case .running: return "Running"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .inQueue: return "In Queue"
        case .merging: return "Merging"
        case .merged: return "Merged"
        case .conflicted: return "Conflicted"
        case .cancelled: return "Cancelled"
        }
    }

    var icon: String {
        switch self {
        case .running: return "circle.fill"
        case .completed: return "checkmark.circle"
        case .failed: return "xmark.circle"
        case .inQueue: return "clock"
        case .merging: return "arrow.triangle.merge"
        case .merged: return "checkmark.diamond.fill"
        case .conflicted: return "exclamationmark.triangle"
        case .cancelled: return "minus.circle"
        }
    }
}

// MARK: - Agent Workspace (Runtime)

struct AgentWorkspace: Identifiable, Hashable {
    let id: String
    let directory: URL
    let changeId: String
    let task: String
    let chatSessionId: String
    var status: AgentStatus
    let createdAt: Date
    var filesChanged: [JJFileDiff]
    var elapsedTime: TimeInterval {
        Date().timeIntervalSince(createdAt)
    }

    static func == (lhs: AgentWorkspace, rhs: AgentWorkspace) -> Bool {
        lhs.id == rhs.id && lhs.status == rhs.status
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(status)
    }
}

// MARK: - Merge Queue

enum MergeQueuePriority: Int, Codable, Comparable, Hashable {
    case low = 0
    case normal = 1
    case high = 2
    case urgent = 3

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

enum MergeQueueStatus: String, Codable, Hashable {
    case waiting
    case merging
    case testing
    case passed
    case landed
    case conflicted
    case testFailed
    case cancelled
}

struct TestResult: Codable, Hashable {
    let passed: Bool
    let output: String
    let duration: TimeInterval
    let command: String
}

struct MergeQueueEntry: Identifiable, Codable, Hashable {
    let id: String
    let agentId: String
    let changeId: String
    let task: String
    var priority: MergeQueuePriority
    var status: MergeQueueStatus
    var mergeChangeId: String?
    var testResult: TestResult?
    var conflictFiles: [String]?
    var enqueuedAt: Date
    var startedAt: Date?
    var completedAt: Date?
}

struct MergeQueue: Codable {
    var entries: [MergeQueueEntry] = []
    var testCommand: String?
    var autoResolveConflicts: Bool = true
    var speculativeMerging: Bool = false

    mutating func enqueue(_ entry: MergeQueueEntry) {
        entries.append(entry)
        entries.sort { $0.priority > $1.priority }
    }

    mutating func dequeue() -> MergeQueueEntry? {
        guard let idx = entries.firstIndex(where: { $0.status == .waiting }) else { return nil }
        entries[idx].status = .merging
        entries[idx].startedAt = Date()
        return entries[idx]
    }

    mutating func remove(agentId: String) {
        entries.removeAll { $0.agentId == agentId }
    }

    mutating func reprioritize(agentId: String, priority: MergeQueuePriority) {
        guard let idx = entries.firstIndex(where: { $0.agentId == agentId }) else { return }
        entries[idx].priority = priority
        entries.sort { $0.priority > $1.priority }
    }

    mutating func updateStatus(agentId: String, status: MergeQueueStatus) {
        guard let idx = entries.firstIndex(where: { $0.agentId == agentId }) else { return }
        entries[idx].status = status
        if status == .landed || status == .cancelled || status == .testFailed {
            entries[idx].completedAt = Date()
        }
    }
}

// MARK: - JJ Error

enum JJError: Error, LocalizedError {
    case notAJJRepo
    case commandFailed(String)
    case parseError(String)
    case conflictsDetected([String])
    case workspaceNotFound(String)

    var errorDescription: String? {
        switch self {
        case .notAJJRepo:
            return "Not a jj repository"
        case .commandFailed(let msg):
            return "jj command failed: \(msg)"
        case .parseError(let msg):
            return "Failed to parse jj output: \(msg)"
        case .conflictsDetected(let files):
            return "Conflicts detected in: \(files.joined(separator: ", "))"
        case .workspaceNotFound(let name):
            return "Workspace not found: \(name)"
        }
    }
}

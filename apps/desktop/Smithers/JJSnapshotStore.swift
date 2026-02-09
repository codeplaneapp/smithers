import Foundation
import GRDB

@MainActor
class JJSnapshotStore {
    private var dbQueue: DatabaseQueue?
    private let workspacePath: String

    init(workspacePath: String) {
        self.workspacePath = workspacePath
    }

    func setup() throws {
        let dbDir = URL(fileURLWithPath: workspacePath)
            .appendingPathComponent(".jj")
            .appendingPathComponent("smithers")
        let fm = FileManager.default
        if !fm.fileExists(atPath: dbDir.path) {
            try fm.createDirectory(at: dbDir, withIntermediateDirectories: true)
        }

        let dbPath = dbDir.appendingPathComponent("snapshots.db").path
        var config = Configuration()
        config.prepareDatabase { db in
            db.trace { _ in }
        }
        dbQueue = try DatabaseQueue(path: dbPath, configuration: config)

        try migrate()
    }

    private func migrate() throws {
        guard let dbQueue else { return }

        var migrator = DatabaseMigrator()

        migrator.registerMigration("v1_create_tables") { db in
            try db.create(table: "snapshots", ifNotExists: true) { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("changeId", .text).notNull()
                t.column("commitId", .text)
                t.column("workspacePath", .text).notNull()
                t.column("chatSessionId", .text)
                t.column("chatMessageIndex", .integer)
                t.column("description", .text).notNull().defaults(to: "")
                t.column("snapshotType", .text).notNull()
                t.column("createdAt", .datetime).notNull()
                t.column("metadata", .text)
            }

            try db.create(index: "idx_snapshots_change", on: "snapshots", columns: ["changeId"], ifNotExists: true)
            try db.create(index: "idx_snapshots_workspace", on: "snapshots", columns: ["workspacePath"], ifNotExists: true)
            try db.create(index: "idx_snapshots_chat", on: "snapshots", columns: ["chatSessionId", "chatMessageIndex"], ifNotExists: true)

            try db.create(table: "agent_workspaces", ifNotExists: true) { t in
                t.primaryKey("id", .text)
                t.column("workspacePath", .text).notNull()
                t.column("mainWorkspacePath", .text).notNull()
                t.column("changeId", .text).notNull()
                t.column("task", .text).notNull()
                t.column("chatSessionId", .text)
                t.column("status", .text).notNull()
                t.column("priority", .integer).defaults(to: 1)
                t.column("createdAt", .datetime).notNull()
                t.column("completedAt", .datetime)
                t.column("mergedAt", .datetime)
                t.column("testOutput", .text)
                t.column("conflictFiles", .text)
                t.column("metadata", .text)
            }

            try db.create(index: "idx_agent_status", on: "agent_workspaces", columns: ["status"], ifNotExists: true)

            try db.create(table: "merge_queue_log", ifNotExists: true) { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("agentId", .text).notNull().references("agent_workspaces", onDelete: .cascade)
                t.column("action", .text).notNull()
                t.column("details", .text)
                t.column("timestamp", .datetime).notNull()
            }

            try db.create(index: "idx_merge_log_agent", on: "merge_queue_log", columns: ["agentId"], ifNotExists: true)
        }

        try migrator.migrate(dbQueue)
    }

    // MARK: - Snapshot Operations

    func recordSnapshot(
        changeId: String,
        commitId: String?,
        description: String,
        snapshotType: Snapshot.SnapshotType,
        chatSessionId: String? = nil,
        chatMessageIndex: Int? = nil,
        metadata: String? = nil
    ) throws {
        guard let dbQueue else { return }

        var snapshot = Snapshot(
            id: nil,
            changeId: changeId,
            commitId: commitId,
            workspacePath: workspacePath,
            chatSessionId: chatSessionId,
            chatMessageIndex: chatMessageIndex,
            description: description,
            snapshotType: snapshotType,
            createdAt: Date(),
            metadata: metadata
        )

        try dbQueue.write { db in
            try snapshot.insert(db)
        }
    }

    func snapshotsForChat(sessionId: String) throws -> [Snapshot] {
        guard let dbQueue else { return [] }

        return try dbQueue.read { db in
            try Snapshot
                .filter(Column("chatSessionId") == sessionId)
                .order(Column("createdAt").asc)
                .fetchAll(db)
        }
    }

    func snapshotsForChange(changeId: String) throws -> [Snapshot] {
        guard let dbQueue else { return [] }

        return try dbQueue.read { db in
            try Snapshot
                .filter(Column("changeId") == changeId)
                .order(Column("createdAt").desc)
                .fetchAll(db)
        }
    }

    func snapshotsForWorkspace() throws -> [Snapshot] {
        guard let dbQueue else { return [] }

        return try dbQueue.read { db in
            try Snapshot
                .filter(Column("workspacePath") == workspacePath)
                .order(Column("createdAt").desc)
                .fetchAll(db)
        }
    }

    func latestSnapshot() throws -> Snapshot? {
        guard let dbQueue else { return nil }

        return try dbQueue.read { db in
            try Snapshot
                .filter(Column("workspacePath") == workspacePath)
                .order(Column("createdAt").desc)
                .fetchOne(db)
        }
    }

    func snapshotForMessage(sessionId: String, messageIndex: Int) throws -> Snapshot? {
        guard let dbQueue else { return nil }

        return try dbQueue.read { db in
            try Snapshot
                .filter(Column("chatSessionId") == sessionId &&
                        Column("chatMessageIndex") == messageIndex)
                .fetchOne(db)
        }
    }

    // MARK: - Agent Workspace Operations

    func recordAgentWorkspace(_ record: AgentWorkspaceRecord) throws {
        guard let dbQueue else { return }

        try dbQueue.write { db in
            try record.insert(db)
        }
    }

    func updateAgentStatus(id: String, status: AgentStatus, testOutput: String? = nil) throws {
        guard let dbQueue else { return }

        try dbQueue.write { db in
            if var record = try AgentWorkspaceRecord.fetchOne(db, key: id) {
                record.status = status.rawValue
                if let testOutput {
                    record.testOutput = testOutput
                }
                if status == .completed || status == .failed || status == .cancelled {
                    record.completedAt = Date()
                }
                if status == .merged {
                    record.mergedAt = Date()
                }
                try record.update(db)
            }
        }
    }

    func agentWorkspaces(status: AgentStatus? = nil) throws -> [AgentWorkspaceRecord] {
        guard let dbQueue else { return [] }

        return try dbQueue.read { db in
            if let status {
                return try AgentWorkspaceRecord
                    .filter(Column("status") == status.rawValue)
                    .order(Column("createdAt").desc)
                    .fetchAll(db)
            }
            return try AgentWorkspaceRecord
                .order(Column("createdAt").desc)
                .fetchAll(db)
        }
    }

    // MARK: - Merge Queue Log Operations

    func logMergeQueueAction(agentId: String, action: String, details: String? = nil) throws {
        guard let dbQueue else { return }

        var entry = MergeQueueLogEntry(
            id: nil,
            agentId: agentId,
            action: action,
            details: details,
            timestamp: Date()
        )

        try dbQueue.write { db in
            try entry.insert(db)
        }
    }

    func mergeQueueLog(agentId: String) throws -> [MergeQueueLogEntry] {
        guard let dbQueue else { return [] }

        return try dbQueue.read { db in
            try MergeQueueLogEntry
                .filter(Column("agentId") == agentId)
                .order(Column("timestamp").asc)
                .fetchAll(db)
        }
    }
}

import Foundation

@MainActor
class JJService: ObservableObject {
    let workingDirectory: URL

    @Published private(set) var currentStatus: JJStatus?
    @Published private(set) var isAvailable: Bool = false
    @Published private(set) var detectedVCSType: VCSType = .none

    init(workingDirectory: URL) {
        self.workingDirectory = workingDirectory
    }

    // MARK: - VCS Detection

    func detectVCS() -> VCSType {
        let jjDir = workingDirectory.appendingPathComponent(".jj")
        let gitDir = workingDirectory.appendingPathComponent(".git")
        let fm = FileManager.default
        let hasJJ = fm.fileExists(atPath: jjDir.path)
        let hasGit = fm.fileExists(atPath: gitDir.path)

        if hasJJ && hasGit {
            detectedVCSType = .jjColocated
        } else if hasJJ {
            detectedVCSType = .jjNative
        } else if hasGit {
            detectedVCSType = .gitOnly
        } else {
            detectedVCSType = .none
        }
        isAvailable = hasJJ
        return detectedVCSType
    }

    func initJJColocated() async throws {
        _ = try await runJJ(["git", "init", "--colocate"])
        isAvailable = true
        detectedVCSType = .jjColocated
    }

    // MARK: - Core Operations

    func status() async throws -> JJStatus {
        let logOutput = try await runJJ([
            "log", "--no-graph", "-r", "@",
            "-T", Self.changeTemplate
        ])
        let parentOutput = try await runJJ([
            "log", "--no-graph", "-r", "@-",
            "-T", Self.changeTemplate
        ])
        let summaryOutput = try await runJJ(["diff", "--summary", "-r", "@"])
        let statusOutput = try await runJJ(["status"])

        let workingCopy = try parseChange(logOutput)
        let parents = try parseChanges(parentOutput)
        let files = parseDiffSummary(summaryOutput)
        let conflicts = parseConflicts(statusOutput)
        let isColocated = detectedVCSType == .jjColocated

        let s = JJStatus(
            workingCopyChange: workingCopy,
            parentChanges: parents,
            modifiedFiles: files,
            conflicts: conflicts,
            isColocated: isColocated
        )
        currentStatus = s
        return s
    }

    func log(revset: String? = nil, limit: Int? = nil) async throws -> [JJChange] {
        var args = ["log", "--no-graph", "-T", Self.changeTemplate]
        if let revset {
            args += ["-r", revset]
        }
        if let limit {
            args += ["-n", "\(limit)"]
        }
        let output = try await runJJ(args)
        return try parseChanges(output)
    }

    func diff(revision: String? = nil, paths: [String]? = nil) async throws -> String {
        var args = ["diff"]
        if let revision {
            args += ["-r", revision]
        }
        if let paths {
            args += paths
        }
        return try await runJJ(args)
    }

    func diffSummary(revision: String? = nil) async throws -> [JJFileDiff] {
        var args = ["diff", "--summary"]
        if let revision {
            args += ["-r", revision]
        }
        let output = try await runJJ(args)
        return parseDiffSummary(output)
    }

    // MARK: - Snapshotting

    func describe(revision: String = "@", message: String) async throws {
        _ = try await runJJ(["describe", "-r", revision, "-m", message])
    }

    func newChange(description: String? = nil) async throws -> JJChange {
        var args = ["new"]
        if let description {
            args += ["-m", description]
        }
        _ = try await runJJ(args)
        // Return the new working copy change
        let output = try await runJJ([
            "log", "--no-graph", "-r", "@",
            "-T", Self.changeTemplate
        ])
        return try parseChange(output)
    }

    func snapshot(description: String? = nil) async throws -> JJChange {
        if let description {
            try await describe(message: description)
        }
        return try await newChange()
    }

    // MARK: - History Manipulation

    func squash(revision: String? = nil, into: String? = nil) async throws {
        var args = ["squash"]
        if let revision {
            args += ["-r", revision]
        }
        if let into {
            args += ["--into", into]
        }
        _ = try await runJJ(args)
    }

    func abandon(revision: String) async throws {
        _ = try await runJJ(["abandon", "-r", revision])
    }

    func undo() async throws {
        _ = try await runJJ(["undo"])
    }

    func opLog(limit: Int? = nil) async throws -> [JJOperation] {
        var args = ["op", "log", "--no-graph", "-T", Self.opTemplate]
        if let limit {
            args += ["-n", "\(limit)"]
        }
        let output = try await runJJ(args)
        return parseOperations(output)
    }

    func opRestore(operationId: String) async throws {
        _ = try await runJJ(["op", "restore", operationId])
    }

    // MARK: - Bookmarks

    func bookmarkList() async throws -> [JJBookmark] {
        let output = try await runJJ(["bookmark", "list", "--all", "-T", Self.bookmarkTemplate])
        return parseBookmarks(output)
    }

    func bookmarkCreate(name: String, revision: String? = nil) async throws {
        var args = ["bookmark", "create", name]
        if let revision {
            args += ["-r", revision]
        }
        _ = try await runJJ(args)
    }

    func bookmarkSet(name: String, revision: String) async throws {
        _ = try await runJJ(["bookmark", "set", name, "-r", revision])
    }

    // MARK: - Git Interop

    func gitPush(bookmark: String? = nil, allTracked: Bool = false) async throws {
        var args = ["git", "push"]
        if let bookmark {
            args += ["-b", bookmark]
        }
        if allTracked {
            args += ["--all"]
        }
        _ = try await runJJ(args)
    }

    func gitFetch(remote: String? = nil) async throws {
        var args = ["git", "fetch"]
        if let remote {
            args += ["--remote", remote]
        }
        _ = try await runJJ(args)
    }

    // MARK: - Workspaces

    func workspaceAdd(path: String, revision: String? = nil, description: String? = nil) async throws -> JJWorkspaceInfo {
        var args = ["workspace", "add", path]
        if let revision {
            args += ["-r", revision]
        }
        _ = try await runJJ(args)
        if let description {
            let wsJJ = JJService(workingDirectory: URL(fileURLWithPath: path))
            try await wsJJ.describe(message: description)
        }
        let logOutput = try await runJJ([
            "log", "--no-graph", "-r", "@",
            "-T", Self.changeTemplate
        ])
        let change = try parseChange(logOutput)
        let name = URL(fileURLWithPath: path).lastPathComponent
        return JJWorkspaceInfo(
            name: name,
            path: path,
            workingCopyChangeId: change.changeId,
            isStale: false
        )
    }

    func workspaceList() async throws -> [JJWorkspaceInfo] {
        let output = try await runJJ(["workspace", "list"])
        return parseWorkspaceList(output)
    }

    func workspaceForget(name: String) async throws {
        _ = try await runJJ(["workspace", "forget", name])
    }

    func workspaceUpdateStale() async throws {
        _ = try await runJJ(["workspace", "update-stale"])
    }

    // MARK: - Git Notes

    func addGitNote(commitId: String, note: String, ref: String = "refs/notes/smithers") async throws {
        _ = try await runGit(["notes", "--ref=\(ref)", "add", "-f", "-m", note, commitId])
    }

    func readGitNote(commitId: String, ref: String = "refs/notes/smithers") async throws -> String? {
        do {
            return try await runGit(["notes", "--ref=\(ref)", "show", commitId])
        } catch {
            return nil
        }
    }

    // MARK: - Annotate (Blame)

    func annotate(path: String) async throws -> String {
        return try await runJJ(["file", "annotate", path])
    }

    // MARK: - Commit ID Lookup

    func commitIdForChange(_ changeId: String) async throws -> String {
        let output = try await runJJ([
            "log", "--no-graph", "-r", changeId,
            "-T", "commit_id"
        ])
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Refresh

    func refresh() async {
        guard isAvailable else { return }
        do {
            _ = try await status()
        } catch {
            // Silently fail on refresh
        }
    }

    // MARK: - Private Helpers

    static let changeTemplate = """
    '{"change_id": ' ++ change_id.escape_json() ++ ', "commit_id": ' ++ commit_id.escape_json() ++ ', "description": ' ++ description.escape_json() ++ ', "author_name": ' ++ author.name().escape_json() ++ ', "author_email": ' ++ author.email().escape_json() ++ ', "timestamp": ' ++ author.timestamp().utc().format("%Y-%m-%dT%H:%M:%SZ").escape_json() ++ ', "empty": ' ++ empty ++ ', "working_copy": ' ++ working_copy ++ ', "parents": "' ++ parents.map(|p| p.change_id()) ++ '", "bookmarks": "' ++ bookmarks ++ '"}\\n'
    """

    private static let opTemplate = """
    '{"operation_id": ' ++ self.id().escape_json() ++ ', "description": ' ++ self.description().escape_json() ++ ', "timestamp": ' ++ self.time().start().utc().format("%Y-%m-%dT%H:%M:%SZ").escape_json() ++ ', "user": ' ++ self.user().escape_json() ++ '}\\n'
    """

    private static let bookmarkTemplate = """
    '{"name": ' ++ name.escape_json() ++ ', "change_id": ' ++ commit_id.short(8).escape_json() ++ ', "is_tracking": ' ++ tracking_present ++ ', "remote": ' ++ if(tracking_present, remote.escape_json(), '""') ++ '}\\n'
    """

    func runJJ(_ args: [String]) async throws -> String {
        try await runProcess("/usr/bin/env", arguments: ["jj"] + args + ["--no-pager", "--color=never"])
    }

    private func runGit(_ args: [String]) async throws -> String {
        try await runProcess("/usr/bin/env", arguments: ["git"] + args)
    }

    private func runProcess(_ executable: String, arguments: [String]) async throws -> String {
        let wd = workingDirectory
        return try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.currentDirectoryURL = wd
            process.environment = ProcessInfo.processInfo.environment

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            try process.run()

            let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()

            process.waitUntilExit()

            let output = String(data: stdoutData, encoding: .utf8) ?? ""
            let errorOutput = String(data: stderrData, encoding: .utf8) ?? ""

            if process.terminationStatus != 0 {
                throw JJError.commandFailed(errorOutput.isEmpty ? "Exit code \(process.terminationStatus)" : errorOutput)
            }

            return output
        }.value
    }

    // MARK: - Parsing

    func parseChange(_ output: String) throws -> JJChange {
        let changes = try parseChanges(output)
        guard let first = changes.first else {
            throw JJError.parseError("No change found in output")
        }
        return first
    }

    func parseChanges(_ output: String) throws -> [JJChange] {
        let lines = output.split(separator: "\n", omittingEmptySubsequences: true)
        var changes: [JJChange] = []

        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions = [.withInternetDateTime]

        for line in lines {
            guard let data = line.data(using: .utf8) else { continue }
            do {
                let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                guard let raw else { continue }

                let changeId = raw["change_id"] as? String ?? ""
                let commitId = raw["commit_id"] as? String ?? ""
                let description = raw["description"] as? String ?? ""
                let authorName = raw["author_name"] as? String ?? ""
                let authorEmail = raw["author_email"] as? String ?? ""
                let timestampStr = raw["timestamp"] as? String ?? ""
                let timestamp = dateFormatter.date(from: timestampStr) ?? Date()
                let isEmpty = (raw["empty"] as? Bool) ?? (raw["empty"] as? String == "true")
                let isWorkingCopy = (raw["working_copy"] as? Bool) ?? (raw["working_copy"] as? String == "true")

                let parentsStr = raw["parents"] as? String ?? ""
                let parents = parentsStr.isEmpty ? [] : parentsStr.components(separatedBy: " ").filter { !$0.isEmpty }

                let bookmarksStr = raw["bookmarks"] as? String ?? ""
                let bookmarks = bookmarksStr.isEmpty ? [] : bookmarksStr.components(separatedBy: " ").filter { !$0.isEmpty }

                changes.append(JJChange(
                    changeId: changeId,
                    commitId: commitId,
                    description: description,
                    authorName: authorName,
                    authorEmail: authorEmail,
                    timestamp: timestamp,
                    isEmpty: isEmpty,
                    isWorkingCopy: isWorkingCopy,
                    parents: parents,
                    bookmarks: bookmarks
                ))
            } catch {
                continue
            }
        }

        return changes
    }

    func parseDiffSummary(_ output: String) -> [JJFileDiff] {
        let lines = output.split(separator: "\n", omittingEmptySubsequences: true)
        var files: [JJFileDiff] = []

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.count > 2 else { continue }

            let statusChar = String(trimmed.prefix(1))
            let path = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)

            let status: JJFileDiff.Status
            switch statusChar {
            case "M": status = .modified
            case "A": status = .added
            case "D": status = .deleted
            case "R": status = .renamed
            default: continue
            }

            // Handle renames: "R old_path => new_path"
            if status == .renamed {
                let parts = path.components(separatedBy: " => ")
                if parts.count == 2 {
                    files.append(JJFileDiff(status: status, path: parts[1], oldPath: parts[0]))
                } else {
                    files.append(JJFileDiff(status: status, path: path, oldPath: nil))
                }
            } else {
                files.append(JJFileDiff(status: status, path: path, oldPath: nil))
            }
        }

        return files
    }

    func parseConflicts(_ statusOutput: String) -> [String] {
        var conflicts: [String] = []
        let lines = statusOutput.split(separator: "\n")
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("C ") {
                conflicts.append(String(trimmed.dropFirst(2)))
            }
        }
        return conflicts
    }

    func parseOperations(_ output: String) -> [JJOperation] {
        let lines = output.split(separator: "\n", omittingEmptySubsequences: true)
        var ops: [JJOperation] = []

        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions = [.withInternetDateTime]

        for line in lines {
            guard let data = line.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            let opId = raw["operation_id"] as? String ?? ""
            let description = raw["description"] as? String ?? ""
            let timestampStr = raw["timestamp"] as? String ?? ""
            let timestamp = dateFormatter.date(from: timestampStr) ?? Date()
            let user = raw["user"] as? String ?? ""

            ops.append(JJOperation(
                operationId: opId,
                description: description,
                timestamp: timestamp,
                user: user
            ))
        }

        return ops
    }

    func parseBookmarks(_ output: String) -> [JJBookmark] {
        let lines = output.split(separator: "\n", omittingEmptySubsequences: true)
        var bookmarks: [JJBookmark] = []

        for line in lines {
            guard let data = line.data(using: .utf8),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            let name = raw["name"] as? String ?? ""
            let changeId = raw["change_id"] as? String ?? ""
            let isTracking = (raw["is_tracking"] as? Bool) ?? (raw["is_tracking"] as? String == "true")
            let remote = raw["remote"] as? String
            let effectiveRemote = (remote?.isEmpty ?? true) ? nil : remote

            bookmarks.append(JJBookmark(
                name: name,
                changeId: changeId,
                isTracking: isTracking,
                remote: effectiveRemote,
                isAhead: false,
                isBehind: false
            ))
        }

        return bookmarks
    }

    func parseWorkspaceList(_ output: String) -> [JJWorkspaceInfo] {
        let lines = output.split(separator: "\n", omittingEmptySubsequences: true)
        var workspaces: [JJWorkspaceInfo] = []

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // Format: "name: change_id path (stale)"
            let parts = trimmed.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }

            let name = String(parts[0]).trimmingCharacters(in: .whitespaces)
            let rest = String(parts[1]).trimmingCharacters(in: .whitespaces)
            let isStale = rest.contains("(stale)")

            // Extract change ID (first word after colon)
            let restParts = rest.split(separator: " ")
            let changeId = restParts.first.map(String.init) ?? ""

            workspaces.append(JJWorkspaceInfo(
                name: name,
                path: workingDirectory.path,
                workingCopyChangeId: changeId,
                isStale: isStale
            ))
        }

        return workspaces
    }
}
